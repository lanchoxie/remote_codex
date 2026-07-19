const assert = require('assert');
const MarkdownIt = require('markdown-it');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const { createMarkdownRenderer } = require('../apps/mobile-web/public/markdown-renderer');

function makeRenderer() {
  const dom = new JSDOM('<main id="output"></main>');
  const sanitizer = createDOMPurify(dom.window);
  return {
    dom,
    output: dom.window.document.getElementById('output'),
    renderer: createMarkdownRenderer({
      markdownIt: MarkdownIt,
      sanitizer,
      document: dom.window.document,
    }),
  };
}

const { output, renderer } = makeRenderer();
renderer.render(output, '1. first\n\n2. second\n\n3. third');
assert.strictEqual(output.querySelectorAll(':scope > ol').length, 1);
assert.deepStrictEqual(
  [...output.querySelectorAll(':scope > ol > li')].map((item) => item.textContent.trim()),
  ['first', 'second', 'third']
);

renderer.render(output, '<img src=x onerror=alert(1)>\n\n[jump](javascript:alert(1))');
assert.strictEqual(output.querySelector('img'), null);
assert.strictEqual(output.querySelector('a[href^="javascript:"]'), null);
assert(output.textContent.includes('<img src=x onerror=alert(1)>'));

renderer.render(output, '```js\nconst answer = 42;\n```');
assert.strictEqual(output.querySelectorAll('.markdown-code-card').length, 1);
assert.strictEqual(output.querySelector('.markdown-copy-code').dataset.copyText, 'const answer = 42;\n');

const fallbackDom = new JSDOM('<main id="output"></main>');
const fallbackOutput = fallbackDom.window.document.getElementById('output');
createMarkdownRenderer({ document: fallbackDom.window.document }).render(
  fallbackOutput,
  '<script>window.compromised = true</script>'
);
assert.strictEqual(fallbackOutput.querySelector('script'), null);
assert.strictEqual(fallbackOutput.textContent, '<script>window.compromised = true</script>');

console.log('markdown renderer assertions passed');
