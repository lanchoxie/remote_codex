const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSkillArtifactArchive,
  extractSkillArtifactArchive,
  inspectSkillArtifactArchive,
} = require('../shared/skill-artifact');
const { hashSkillDirectory } = require('../shared/skill-inventory');

const ARCHIVE_MAGIC = Buffer.from('RCSKILL1\n', 'ascii');

function writeFixture(root, name = 'fixture') {
  const skillRoot = path.join(root, name);
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: Complete artifact fixture',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), '#!/usr/bin/env node\nconsole.log("fixture");\n');
  fs.writeFileSync(path.join(skillRoot, 'references', 'guide.md'), '# Guide\n');
  fs.writeFileSync(path.join(skillRoot, 'assets', 'icon.bin'), Buffer.from([0, 1, 2, 127, 128, 254, 255]));
  return skillRoot;
}

function rewriteManifest(archivePath, mutate) {
  const archive = fs.readFileSync(archivePath);
  assert(archive.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC));
  const manifestLength = archive.readUInt32BE(ARCHIVE_MAGIC.length);
  const manifestStart = ARCHIVE_MAGIC.length + 4;
  const manifestEnd = manifestStart + manifestLength;
  const manifest = JSON.parse(archive.subarray(manifestStart, manifestEnd).toString('utf8'));
  mutate(manifest);
  const nextManifest = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(nextManifest.length, 0);
  fs.writeFileSync(archivePath, Buffer.concat([
    ARCHIVE_MAGIC,
    length,
    nextManifest,
    archive.subarray(manifestEnd),
  ]));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-artifact-'));
  try {
    const skillRoot = writeFixture(root);
    const firstPath = path.join(root, 'first.rcskill');
    const secondPath = path.join(root, 'second.rcskill');
    const first = await createSkillArtifactArchive(skillRoot, firstPath);
    const second = await createSkillArtifactArchive(skillRoot, secondPath);
    const observed = await hashSkillDirectory(skillRoot);

    assert.strictEqual(first.artifactId, observed.hash);
    assert.strictEqual(first.contentHash, observed.hash);
    assert.strictEqual(first.fileCount, 4);
    assert.strictEqual(first.totalBytes, observed.totalBytes);
    assert.deepStrictEqual(first.files.map((file) => file.path), [
      'SKILL.md',
      'assets/icon.bin',
      'references/guide.md',
      'scripts/run.js',
    ]);
    assert(first.files.find((file) => file.path === 'scripts/run.js').executable);
    assert.deepStrictEqual(fs.readFileSync(firstPath), fs.readFileSync(secondPath));
    assert.strictEqual(second.contentHash, first.contentHash);

    const inspected = await inspectSkillArtifactArchive(firstPath);
    assert.strictEqual(inspected.contentHash, observed.hash);
    assert.strictEqual(inspected.archiveBytes, fs.statSync(firstPath).size);
    assert.deepStrictEqual(inspected.files, first.files);

    const extractedPath = path.join(root, 'extracted');
    const extracted = await extractSkillArtifactArchive(firstPath, extractedPath, {
      expectedHash: first.contentHash,
    });
    assert.strictEqual(extracted.contentHash, first.contentHash);
    assert.strictEqual((await hashSkillDirectory(extractedPath)).hash, first.contentHash);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(extractedPath, 'assets', 'icon.bin')),
      fs.readFileSync(path.join(skillRoot, 'assets', 'icon.bin'))
    );
    assert.strictEqual(
      fs.readFileSync(path.join(extractedPath, 'scripts', 'run.js'), 'utf8'),
      fs.readFileSync(path.join(skillRoot, 'scripts', 'run.js'), 'utf8')
    );
    if (process.platform !== 'win32') {
      assert(fs.statSync(path.join(extractedPath, 'scripts', 'run.js')).mode & 0o111);
    }

    const existingTarget = path.join(root, 'existing-target');
    fs.mkdirSync(existingTarget);
    await assert.rejects(
      extractSkillArtifactArchive(firstPath, existingTarget),
      /already exists|new directory/i
    );

    const mismatchedTarget = path.join(root, 'mismatched-target');
    await assert.rejects(
      extractSkillArtifactArchive(firstPath, mismatchedTarget, {
        expectedHash: `sha256:${'f'.repeat(64)}`,
      }),
      /expected|hash/i
    );
    assert(!fs.existsSync(mismatchedTarget));

    const tamperedPath = path.join(root, 'tampered.rcskill');
    fs.copyFileSync(firstPath, tamperedPath);
    const tampered = fs.readFileSync(tamperedPath);
    tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(tamperedPath, tampered);
    await assert.rejects(inspectSkillArtifactArchive(tamperedPath), /hash|content/i);
    const tamperedExtractPath = path.join(root, 'tampered-extract');
    await assert.rejects(
      extractSkillArtifactArchive(tamperedPath, tamperedExtractPath),
      /hash|content/i
    );
    assert(!fs.existsSync(tamperedExtractPath));

    const traversalPath = path.join(root, 'traversal.rcskill');
    fs.copyFileSync(firstPath, traversalPath);
    rewriteManifest(traversalPath, (manifest) => {
      manifest.files.find((file) => file.path === 'assets/icon.bin').path = '../escape.bin';
    });
    await assert.rejects(inspectSkillArtifactArchive(traversalPath), /relative|travers|path/i);

    const absolutePath = path.join(root, 'absolute.rcskill');
    fs.copyFileSync(firstPath, absolutePath);
    rewriteManifest(absolutePath, (manifest) => {
      manifest.files.find((file) => file.path === 'assets/icon.bin').path = '/escape.bin';
    });
    await assert.rejects(inspectSkillArtifactArchive(absolutePath), /relative|absolute|path/i);

    const duplicatePath = path.join(root, 'duplicate.rcskill');
    fs.copyFileSync(firstPath, duplicatePath);
    rewriteManifest(duplicatePath, (manifest) => {
      manifest.files[1].path = manifest.files[0].path;
    });
    await assert.rejects(inspectSkillArtifactArchive(duplicatePath), /duplicate|unique|order|sorted/i);

    const truncatedPath = path.join(root, 'truncated.rcskill');
    fs.writeFileSync(truncatedPath, fs.readFileSync(firstPath).subarray(0, fs.statSync(firstPath).size - 1));
    await assert.rejects(inspectSkillArtifactArchive(truncatedPath), /truncated|length|size/i);

    await assert.rejects(
      createSkillArtifactArchive(skillRoot, path.join(root, 'too-many.rcskill'), { maxFiles: 3 }),
      /more than 3 files/i
    );
    await assert.rejects(
      createSkillArtifactArchive(skillRoot, path.join(root, 'too-large.rcskill'), { maxBytes: 16 }),
      /exceeds 16 bytes/i
    );

    const missingMarkdown = path.join(root, 'missing-markdown');
    fs.mkdirSync(missingMarkdown);
    fs.writeFileSync(path.join(missingMarkdown, 'note.txt'), 'not a skill');
    await assert.rejects(
      createSkillArtifactArchive(missingMarkdown, path.join(root, 'missing.rcskill')),
      /SKILL\.md/i
    );

    const outsideRoot = path.join(root, 'outside');
    fs.mkdirSync(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret');
    const linkedRoot = writeFixture(root, 'linked');
    fs.symlinkSync(
      outsideRoot,
      path.join(linkedRoot, 'assets', 'escape-directory'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await assert.rejects(
      createSkillArtifactArchive(linkedRoot, path.join(root, 'linked.rcskill')),
      /outside skill root/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('skill artifact assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
