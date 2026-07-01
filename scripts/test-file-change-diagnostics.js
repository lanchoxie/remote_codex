const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js'), 'utf8');

function extractFunctionSource(name) {
  const marker = `function ${name}`;
  const start = appSource.indexOf(marker);
  assert(start >= 0, `${name} was not found`);
  let index = appSource.indexOf('{', start);
  assert(index > start, `${name} body was not found`);
  let depth = 0;
  for (; index < appSource.length; index += 1) {
    const char = appSource[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return appSource.slice(start, index + 1);
      }
    }
  }
  throw new Error(`${name} body did not terminate`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  extractFunctionSource('countDiffLines'),
  extractFunctionSource('countTextLines'),
  extractFunctionSource('toCount'),
  extractFunctionSource('normalizeFileChangeStatus'),
  extractFunctionSource('fileChangeStatusLabel'),
  extractFunctionSource('pathFromDiffHeader'),
  extractFunctionSource('splitUnifiedDiff'),
  extractFunctionSource('normalizeFileChangeRecord'),
  extractFunctionSource('parsePatchApplyUpdatedFiles'),
  extractFunctionSource('normalizeFileChanges'),
].join('\n'), sandbox);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const approvalChanges = sandbox.normalizeFileChanges({
  kind: 'approval',
  method: 'item/fileChange/requestApproval',
  data: {
    fileChanges: {
      'src/new.js': { type: 'add', content: 'console.log(\"new\");\n' },
      'src/old.js': { type: 'delete', content: 'console.log(\"old\");\n' },
      'src/edit.js': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' },
    },
  },
});
assert.deepStrictEqual(
  plain(approvalChanges.map((change) => ({
    path: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
  }))),
  [
    { path: 'src/new.js', status: 'added', additions: 1, deletions: null },
    { path: 'src/old.js', status: 'deleted', additions: null, deletions: 1 },
    { path: 'src/edit.js', status: 'modified', additions: 1, deletions: 1 },
  ],
  'fileChange approval payloads should render added/deleted/modified files'
);

const patchStdoutChanges = sandbox.normalizeFileChanges({
  kind: 'file-change',
  method: 'event_msg/patch_apply_end',
  data: {
    stdout: [
      'Success. Updated the following files:',
      'A scripts/new_job.sh',
      'M scripts/existing_job.sh',
      'D scripts/old_job.sh',
    ].join('\n'),
    changes: [],
  },
});
assert.deepStrictEqual(
  plain(patchStdoutChanges.map((change) => ({
    path: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    diff: change.diff,
  }))),
  [
    { path: 'scripts/new_job.sh', status: 'added', additions: null, deletions: null, diff: '' },
    { path: 'scripts/existing_job.sh', status: 'modified', additions: null, deletions: null, diff: '' },
    { path: 'scripts/old_job.sh', status: 'deleted', additions: null, deletions: null, diff: '' },
  ],
  'patch_apply_end stdout should render file status when structured changes are empty'
);

const plainContent = sandbox.normalizeFileChanges({
  kind: 'file-change',
  method: 'event_msg/patch_apply_end',
  data: {
    path: 'notes.txt',
    content: 'this is not a unified diff',
  },
});
assert.strictEqual(
  plainContent.length,
  0,
  'plain content/text should not become workspace change +0 -0'
);

const {
  normalizeAppServerFileChanges,
} = require('../apps/host-agent/codex-app-server-runner');
const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'host-agent', 'codex-app-server-runner.js'), 'utf8');

const runnerChanges = normalizeAppServerFileChanges({
  'src/new.js': { type: 'add', content: 'console.log(\"new\");\n' },
  'src/edit.js': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' },
});
assert.deepStrictEqual(
  runnerChanges.map((change) => ({
    path: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
  })),
  [
    { path: 'src/new.js', status: 'added', additions: 1, deletions: null },
    { path: 'src/edit.js', status: 'modified', additions: 1, deletions: 1 },
  ],
  'host-agent should normalize app-server fileChange approval payloads for persistence'
);

const fileChangeBranchStart = runnerSource.indexOf("if (method === 'item/fileChange/requestApproval')");
assert(fileChangeBranchStart >= 0, 'fileChange approval branch should exist');
const fileChangeBranchEnd = runnerSource.indexOf("if (method === 'item/permissions/requestApproval')", fileChangeBranchStart);
assert(fileChangeBranchEnd > fileChangeBranchStart, 'fileChange approval branch should be bounded');
const fileChangeBranch = runnerSource.slice(fileChangeBranchStart, fileChangeBranchEnd);
assert(
  fileChangeBranch.includes('normalizeAppServerFileChanges(params.fileChanges)'),
  'fileChange approval branch should normalize app-server fileChanges'
);
assert(
  fileChangeBranch.includes('await this.emitDiagnostic'),
  'fileChange approval branch should persist fileChanges as a session diagnostic'
);

console.log('file change diagnostic assertions passed');
