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

renderer.render(output, [
  '| Name | Metric A | Metric B | Metric C | Metric D | Metric E |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  '| deliberately-wide-row | 123 | 456 | 789 | 1011 | 1213 |',
].join('\n'));
const tableWrapper = output.querySelector('.markdown-table-wrap');
assert(tableWrapper, 'Markdown tables must have a local horizontal scroll container');
assert.strictEqual(tableWrapper.parentElement, output);
assert.strictEqual(tableWrapper.querySelector(':scope > table'), output.querySelector('table'));
assert.strictEqual(tableWrapper.getAttribute('role'), 'region');
assert.strictEqual(tableWrapper.getAttribute('aria-label'), 'Scrollable table');
assert.strictEqual(tableWrapper.tabIndex, 0);

const displayMath = String.raw`\[
\Delta E_{\rm L\rightarrow RS}
E(\text{completely mixed rocksalt})
E(\text{fully ordered layered})
\]`;
renderer.render(output, displayMath);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 1);
assert.strictEqual(output.querySelector('.markdown-math-block').textContent, displayMath);
assert.strictEqual(output.querySelectorAll('h1, h2').length, 0);

const matrixMath = String.raw`\[
\begin{bmatrix}
1 & 2 & 3\\
4 & 5 & 6\\
7 & 8 & 9
\end{bmatrix}
\begin{pmatrix}
x\\y\\z
\end{pmatrix}
=
\begin{pmatrix}
14\\32\\50
\end{pmatrix}
\]`;
renderer.render(output, matrixMath);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 1);
assert.strictEqual(output.querySelector('.markdown-math-block').textContent, matrixMath);
assert.strictEqual(output.querySelectorAll('h1, h2').length, 0, 'matrix equality must not become a Setext heading');

const compactMatrixMath = String.raw`\[\begin{bmatrix}
1 & 0\\
0 & 1
\end{bmatrix}\]`;
renderer.render(output, compactMatrixMath);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 1);
assert.strictEqual(output.querySelector('.markdown-math-block').textContent, compactMatrixMath);
assert.strictEqual(output.querySelectorAll('h1, h2').length, 0);

const casesMath = String.raw`$$
f(x)=\begin{cases}
x^2, & x\ge 0,\\
-x, & x<0.
\end{cases}
$$`;
renderer.render(output, casesMath);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 1);
assert.strictEqual(output.querySelector('.markdown-math-block').textContent, casesMath);
assert.strictEqual(output.querySelectorAll('ul, blockquote, h1, h2').length, 0);

const completelyMixed = '\u5b8c\u5168\u6df7\u6392';
const fullyOrdered = '\u5b8c\u5168\u6709\u5e8f';
const bareDisplayMath = String.raw`[ \Delta E_{\rm L\rightarrow RS}
 =
E(\text{${completelyMixed} rocksalt})
E(\text{${fullyOrdered} layered})
]`;
renderer.render(output, bareDisplayMath);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 1);
assert(output.querySelector('.markdown-math-block').textContent.startsWith('\\['));
assert(output.querySelector('.markdown-math-block').textContent.endsWith('\\]'));
assert.strictEqual(output.querySelectorAll('h1, h2').length, 0);

renderer.render(output, String.raw`Inline \(E=mc^2\) and $a*b*c$.`);
assert.strictEqual(output.querySelectorAll('.markdown-math-inline').length, 2);
assert.strictEqual(output.querySelectorAll('em').length, 0, 'math payload must bypass Markdown emphasis parsing');

renderer.render(output, String.raw`$$a*b*c$$`);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 1);
assert.strictEqual(output.querySelectorAll('em').length, 0);

for (const ordinaryText of [
  '[\nnotes\n]',
  String.raw`[ C:\Users\example-user ]`,
  '[label](https://example.com)',
]) {
  renderer.render(output, ordinaryText);
  assert.strictEqual(output.querySelectorAll('.markdown-math-block, .markdown-math-inline').length, 0);
}

renderer.render(output, String.raw`~~~
[ \Delta x_{a} ]
~~~`);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 0);
assert.strictEqual(output.querySelectorAll('.markdown-code-card').length, 1);

renderer.render(output, `    ${String.raw`[ \Delta x_{a} ]`}`);
assert.strictEqual(output.querySelectorAll('.markdown-math-block').length, 0);
assert.strictEqual(output.querySelectorAll('.markdown-code-card').length, 1);

renderer.render(output, String.raw`\[\text{<img src=x onerror=alert(1)>}\]`);
assert.strictEqual(output.querySelector('img'), null);
assert(output.querySelector('.markdown-math-block').textContent.includes('<img src=x onerror=alert(1)>'));

const fallbackDom = new JSDOM('<main id="output"></main>');
const fallbackOutput = fallbackDom.window.document.getElementById('output');
createMarkdownRenderer({ document: fallbackDom.window.document }).render(
  fallbackOutput,
  '<script>window.compromised = true</script>'
);
assert.strictEqual(fallbackOutput.querySelector('script'), null);
assert.strictEqual(fallbackOutput.textContent, '<script>window.compromised = true</script>');

console.log('markdown renderer assertions passed');
