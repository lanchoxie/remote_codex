const { checkLocalCodexPreflight } = require('../shared/codex-preflight');

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return '';
  }
  return process.argv[index + 1];
}

const result = checkLocalCodexPreflight({
  codexHome: argValue('--codex-home'),
  codexBin: argValue('--codex-bin'),
});

const summary = {
  ok: result.ok,
  codexHome: result.codexHome,
  codexBin: result.codexBin || '',
  errors: result.errors,
  warnings: result.warnings,
};

console.log(JSON.stringify(summary, null, 2));
process.exit(result.ok ? 0 : 1);
