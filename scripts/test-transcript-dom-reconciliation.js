const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js'),
  'utf8'
);

function extractFunction(name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert(start >= 0, name + ' was not found in app.js');
  const nextFunction = source.indexOf('\nfunction ', start + marker.length);
  const block = source.slice(start, nextFunction >= 0 ? nextFunction : source.length).trim();
  assert(block.endsWith('}'), name + ' did not have a complete body');
  return block;
}

const renderStart = source.indexOf('function renderTranscript(');
const renderEnd = source.indexOf('\nfunction renderLocaleLabels(', renderStart);
assert(renderStart >= 0 && renderEnd > renderStart);
const renderSource = source.slice(renderStart, renderEnd);
assert(!renderSource.includes("log.innerHTML = ''"));
assert(renderSource.includes('reconcileTranscriptChildren('));

const dom = new JSDOM('<!doctype html><body><div id="log"></div></body>');
const context = { document: dom.window.document };
vm.createContext(context);
vm.runInContext(extractFunction('transcriptNodeAliasList'), context);
vm.runInContext(extractFunction('reconcileTranscriptChildren'), context);

function node(key, version, className = 'message') {
  const element = dom.window.document.createElement('div');
  element.className = className;
  element.dataset.transcriptNodeKey = key;
  element.dataset.transcriptRenderVersion = version;
  return element;
}

const log = dom.window.document.getElementById('log');
const oldUser = node('message:user-1', 'user-v1', 'message user');
const oldThinking = node('thinking:user-1', 'thinking-v1', 'message thinking');
const oldScroller = dom.window.document.createElement('div');
oldScroller.className = 'thinking-content';
oldThinking.appendChild(oldScroller);
const oldAssistant = node('message:assistant-1', 'assistant-v1', 'message agent');
log.append(oldUser, oldThinking, oldAssistant);

let unchangedBuilds = 0;
const observer = new dom.window.MutationObserver(() => {});
observer.observe(log, { childList: true, subtree: true });
context.reconcileTranscriptChildren(log, [
  {
    key: 'message:user-1',
    version: 'user-v1',
    build() {
      unchangedBuilds += 1;
      return node('message:user-1', 'user-v1');
    },
  },
  {
    key: 'thinking:user-1',
    version: 'thinking-v2',
    build: () => node('thinking:user-1', 'thinking-v2', 'message thinking'),
    patch(existing) {
      existing.dataset.transcriptRenderVersion = 'thinking-v2';
      return existing;
    },
  },
  {
    key: 'message:assistant-1',
    version: 'assistant-v1',
    build: () => node('message:assistant-1', 'assistant-v1'),
  },
  {
    key: 'message:assistant-2',
    version: 'assistant-v2',
    build: () => node('message:assistant-2', 'assistant-v2', 'message agent'),
  },
]);

assert.strictEqual(unchangedBuilds, 0);
assert.strictEqual(log.children[0], oldUser);
assert.strictEqual(log.children[1], oldThinking);
assert.strictEqual(oldThinking.querySelector('.thinking-content'), oldScroller);
assert.strictEqual(log.children[2], oldAssistant);
assert.strictEqual(log.children.length, 4);
const removed = observer.takeRecords()
  .flatMap((record) => Array.from(record.removedNodes))
  .filter((item) => [oldUser, oldThinking, oldScroller, oldAssistant].includes(item));
assert.deepStrictEqual(removed, []);

context.reconcileTranscriptChildren(log, [{
  key: 'message:new-session',
  version: 'new-v1',
  build: () => node('message:new-session', 'new-v1'),
}], { replaceAll: true });
assert.strictEqual(log.children.length, 1);
assert.notStrictEqual(log.children[0], oldUser);

console.log('transcript DOM reconciliation assertions passed');
