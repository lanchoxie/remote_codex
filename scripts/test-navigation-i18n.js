const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const modulePath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'ui', 'i18n.js');
const source = fs.readFileSync(modulePath, 'utf8');
const api = require(modulePath);
const suffixes = [
  'keyword', 'path', 'title', 'updatedAt', 'createdAt', 'messageCount',
  'asc', 'desc', 'ascHint', 'descHint', 'clear', 'placeholder', 'previous', 'next',
  'searchMode', 'sortMode', 'toggleDirection', 'online', 'offline', 'noHosts',
  'selectHost', 'checkingHost', 'selectedHost', 'defaultCollection', 'trashCollection',
  'collection', 'scopeDefault', 'summary', 'count', 'waiting', 'loading', 'slow',
  'error', 'localOnly', 'partial', 'fullHits', 'noMatches', 'noSessions',
  'emptyTrash', 'emptyCollection',
];
const expectedParameters = {
  scopeDefault: ['host'],
  summary: ['query', 'scope', 'total', 'visible'],
  count: ['scope', 'total'],
  error: ['error'],
  fullHits: ['count'],
};
const values = Object.freeze({
  host: 'host-example', visible: 0, total: 12, scope: 'user collection',
  query: 'Keyword <test> "quoted"', error: 'HTTP 503', count: 3,
});

function parameterNames(value) {
  return Array.from(value.matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1]).sort();
}

function testDictionarySymmetryAndInterpolation() {
  // Inspect both literal key sets as well as the public API: extra one-locale
  // keys must fail instead of silently escaping the maintained coverage list.
  const keyOccurrences = Array.from(source.matchAll(/^\s*'navSearch\.([A-Za-z0-9_]+)'\s*:/gm), (match) => match[1]);
  assert.deepStrictEqual(keyOccurrences.slice().sort(), [...suffixes, ...suffixes].sort());
  for (const suffix of suffixes) {
    const key = `navSearch.${suffix}`;
    const en = api.translate('en', key);
    const zh = api.translate('zh-CN', key);
    assert.strictEqual(typeof en, 'string', `${key} must exist in English`);
    assert.strictEqual(typeof zh, 'string', `${key} must exist in Chinese`);
    assert(en.length > 0 && zh.length > 0, `${key} must not be empty`);
    assert.deepStrictEqual(parameterNames(en), expectedParameters[suffix] || []);
    assert.deepStrictEqual(parameterNames(zh), expectedParameters[suffix] || []);
    for (const locale of ['en', 'zh-CN']) {
      const rendered = api.translate(locale, key, values);
      assert(!/\{[A-Za-z0-9_]+\}/.test(rendered), `${key} has an unresolved parameter`);
      for (const name of expectedParameters[suffix] || []) {
        assert(rendered.includes(String(values[name])), `${key} must preserve ${name}`);
      }
    }
  }
  assert.strictEqual(api.translate('zh-CN', 'navSearch.waiting'), '正在准备搜索…');
  assert.strictEqual(api.translate('zh-CN', 'navSearch.loading'), '正在搜索完整历史…');
  assert.strictEqual(api.translate('zh-CN', 'navSearch.slow'), '仍在搜索，远端历史较多时可能需要更久…');
  assert.strictEqual(api.translate('zh-CN', 'navSearch.localOnly'), '至少输入 2 个字符搜索完整历史');
  assert.strictEqual(api.translate('zh-CN', 'navSearch.partial'), '远端搜索未完成，当前仅显示缓存结果');
  assert.strictEqual(api.translate('en', 'navSearch.summary', values), '0 of 12 in user collection match "Keyword <test> "quoted""');
  assert.strictEqual(api.translate('en', 'navSearch.fullHits', { count: 0 }), '0 full-history hits');
  assert.strictEqual(api.translate('en', 'navSearch.scopeDefault', null), 'Default on {host}');
  assert.strictEqual(api.translate('en', 'navSearch.scopeDefault', Object.create({ host: 'inherited' })), 'Default on {host}');
  assert.strictEqual(api.translate('en', 'navSearch.scopeDefault', { host: '$& {query}' }), 'Default on $& {query}');
  for (const key of ['unknown', 'navSearch.missing', 'constructor', 'toString', '__proto__', '', undefined]) {
    assert.strictEqual(api.translate('en', key), undefined, `unknown ${String(key)} must fall through`);
    assert.strictEqual(api.translate('zh-CN', key), undefined);
  }
  assert.strictEqual(api.translate('unsupported', 'navSearch.keyword'), '关键词', 'locale fallback matches the application');
}

function testLabelsAndUserOwnedNames() {
  for (const locale of ['en', 'zh-CN']) {
    for (const mode of ['keyword', 'path', 'title']) {
      assert.strictEqual(api.searchModeLabel(locale, mode), api.translate(locale, `navSearch.${mode}`));
    }
    for (const mode of ['updatedAt', 'createdAt', 'messageCount']) {
      assert.strictEqual(api.sortLabel(locale, mode), api.translate(locale, `navSearch.${mode}`));
    }
    for (const unknown of ['', null, undefined, 'constructor', 'unsupported']) {
      assert.strictEqual(api.searchModeLabel(locale, unknown), api.translate(locale, 'navSearch.keyword'));
      assert.strictEqual(api.sortLabel(locale, unknown), api.translate(locale, 'navSearch.updatedAt'));
    }
    assert.strictEqual(api.hostStatusLabel(locale, true), api.translate(locale, 'navSearch.online'));
    assert.strictEqual(api.hostStatusLabel(locale, false), api.translate(locale, 'navSearch.offline'));
    for (const id of ['default', 'trash']) {
      const collection = Object.freeze({ collectionId: id, name: `original ${id}`, system: true });
      assert.strictEqual(api.collectionDisplayName(locale, collection), api.translate(locale, `navSearch.${id === 'default' ? 'default' : 'trash'}Collection`));
      assert.strictEqual(collection.name, `original ${id}`, 'display translation must not mutate persisted collection names');
    }
    for (const name of ['Default', 'Trash', 'Keyword', '关键词', '我的收藏', '  keep spacing  ', '<img src=x onerror=alert(1)>', 'quotes " and $& {host}']) {
      const collection = Object.freeze({ collectionId: 'user-collection', name });
      assert.strictEqual(api.collectionDisplayName(locale, collection), name, 'user names must stay byte-for-byte intact');
      assert.strictEqual(api.collectionDisplayName(locale, { ...collection, system: true }), name, 'only reserved collection IDs are translated');
      assert.strictEqual(api.translate(locale, 'navSearch.scopeDefault', { host: name }).includes(name), true, 'host names remain plain data');
    }
    assert.strictEqual(api.collectionDisplayName(locale, { collectionId: 'DEFAULT', name: 'Default' }), 'Default');
    for (const collection of [null, undefined, {}, { collectionId: 'user', name: '' }]) {
      assert.strictEqual(api.collectionDisplayName(locale, collection), api.translate(locale, 'navSearch.collection'));
    }
    assert.strictEqual(api.speakerLabel(locale, 'assistant'), 'Codex');
    assert.strictEqual(api.speakerLabel(locale, 'Codex'), 'Codex');
    for (const value of ['custom-speaker', '<unsafe>', 'constructor', '__proto__', '  unknown  ']) {
      assert.strictEqual(api.speakerLabel(locale, value), value, 'unknown speakers must not be guessed or modified');
    }
  }
  assert.strictEqual(api.speakerLabel('en', 'user'), 'You');
  assert.strictEqual(api.speakerLabel('zh-CN', 'user'), '你');
  assert.strictEqual(api.speakerLabel('zh-CN', 'SYSTEM'), '系统');
  assert.strictEqual(api.speakerLabel('zh-CN', 'developer'), '开发者');
  assert.strictEqual(api.speakerLabel('zh-CN', 'tool'), '工具');
  assert.strictEqual(api.speakerLabel('zh-CN', 'function'), '工具');
  assert.strictEqual(api.speakerLabel('en', null), 'Match');
  assert.strictEqual(api.speakerLabel('zh-CN', ''), '匹配');
}

function testPureBrowserUmd() {
  const sandbox = {};
  for (const name of ['document', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest']) {
    Object.defineProperty(sandbox, name, {
      get() { throw new Error(`navigation localization must not access ${name}`); },
    });
  }
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  const browserApi = sandbox.RemoteCodexNavigationI18n;
  assert(browserApi, 'browser global must be exposed without CommonJS');
  assert(Object.isFrozen(browserApi));
  assert(Object.isFrozen(api));
  assert.deepStrictEqual(Object.keys(browserApi).sort(), Object.keys(api).sort());
  for (const suffix of suffixes) {
    for (const locale of ['en', 'zh-CN']) {
      assert.strictEqual(browserApi.translate(locale, `navSearch.${suffix}`, values), api.translate(locale, `navSearch.${suffix}`, values));
    }
  }
}

testDictionarySymmetryAndInterpolation();
testLabelsAndUserOwnedNames();
testPureBrowserUmd();
console.log(`Navigation i18n tests passed (${suffixes.length} bilingual keys; labels, user-data preservation, and pure UMD).`);
