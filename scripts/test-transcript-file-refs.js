const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const app = fs.readFileSync(appPath, 'utf8');

function extractFunctionSource(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(app);
  assert(match, `${name} was not found`);
  const start = match.index;
  const afterDeclaration = start + match[0].length;
  const nextFunction = /\nfunction\s+[A-Za-z0-9_$]+\s*\(/.exec(app.slice(afterDeclaration));
  assert(nextFunction, `${name} body did not terminate`);
  return app.slice(start, afterDeclaration + nextFunction.index).trim();
}

const sandbox = {
  IMAGE_FILE_EXTENSIONS: new Set(['png']),
  DOWNLOADABLE_FILE_EXTENSIONS: new Set(['csv', 'png', 'zip']),
  // The extracted browser helpers normally resolve this from app.js.  Keep
  // the focused VM fixture self-contained while exercising structured text.
  structuredThinkingText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => sandbox.structuredThinkingText(item)).filter(Boolean).join('\n');
    if (typeof value === 'object') {
      for (const key of ['text', 'content', 'message', 'path', 'name']) {
        if (value[key] != null) {
          const text = sandbox.structuredThinkingText(value[key]);
          if (text) return text;
        }
      }
      try { return JSON.stringify(value); } catch (_) { return ''; }
    }
    return String(value);
  },
};
vm.createContext(sandbox);
vm.runInContext([
  extractFunctionSource('basename'),
  extractFunctionSource('fileExtension'),
  extractFunctionSource('isDownloadablePath'),
  extractFunctionSource('isBareDownloadableFilename'),
  extractFunctionSource('stripPathPunctuation'),
  extractFunctionSource('normalizeRemoteFilePath'),
  extractFunctionSource('decodePathCandidate'),
  extractFunctionSource('extractFileRefsFromText'),
].join('\n'), sandbox);

const directory = '/dm_data/project/direct_swap_k4_pattern_boxplots_20260717';
const archive = '/dm_data/project/direct_swap_k4_pattern_boxplots_20260717.zip';
const screenshotStyleReply = [
  '**Zip**',
  `- \`${archive}\``,
  '**Directory**',
  `- \`${directory}\``,
  '**Figures**',
  '- `fig_DFT_dataset_direct_swap_k4_boxplot.png`',
  '- `fig_NoTi_4x3_batch_direct_swap_k4_boxplot.png`',
  '- `fig_Ti_batch_direct_swap_k4_boxplot.png`',
  '**Data**',
  '- `direct_swap_k4_top_bottom10_boxplot_stats.csv`',
].join('\n');

assert.deepStrictEqual(
  Array.from(sandbox.extractFileRefsFromText(screenshotStyleReply), (file) => file.path),
  [archive],
  'an absolute path in inline code should produce a file card'
);

assert.deepStrictEqual(
  Array.from(sandbox.extractFileRefsFromText('Result: `plot.png`')),
  [],
  'a bare file name without an explicit directory must remain ambiguous'
);

assert.deepStrictEqual(
  Array.from(sandbox.extractFileRefsFromText('Directory: `/results`; file: `plot.png`')),
  [],
  'a bare file name must not be guessed from nearby prose'
);

assert.deepStrictEqual(
  Array.from(
    sandbox.extractFileRefsFromText('Result: `D:\\results\\report.csv`'),
    (file) => file.path
  ),
  ['D:\\results\\report.csv'],
  'a Windows absolute path in inline code should produce a file card'
);

console.log('transcript file reference checks passed');
