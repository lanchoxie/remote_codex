const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  downloadGithubSkill,
  normalizeGithubSkillSource,
} = require('../apps/relay/github-skill-source');

const ROOT = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function sendJson(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function fileRecord(relativePath, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    name: path.posix.basename(relativePath),
    path: relativePath,
    type: 'file',
    size: buffer.length,
    encoding: 'base64',
    content: buffer.toString('base64'),
  };
}

function createGithubFixtureServer(evilPortRef, fixtureState = {}) {
  const files = new Map([
    ['skills/fixture/SKILL.md', Buffer.from('---\nname: Imported Fixture\ndescription: GitHub fixture\n---\n')],
    ['skills/fixture/scripts/run.js', Buffer.from('#!/usr/bin/env node\nconsole.log("fixture");\n')],
    ['skills/fixture/assets/data.bin', Buffer.from([0, 1, 127, 128, 254, 255])],
    ['skills/redirect/SKILL.md', Buffer.from('---\nname: Redirect\n---\n')],
  ]);
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/repos/owner/repo/git/blobs/blob-fixture') {
      sendJson(res, 200, {
        encoding: 'base64',
        content: Buffer.from([9, 8, 7, 6, 5, 4]).toString('base64'),
        size: 6,
      });
      return;
    }
    const prefix = '/repos/owner/repo/contents/';
    if (!url.pathname.startsWith(prefix) || url.searchParams.get('ref') !== 'main') {
      sendJson(res, 404, { message: 'not found' });
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(prefix.length));
    if (relative === 'skills/fixture' && fixtureState.failFixture) {
      const respond = () => sendJson(res, 500, { message: 'simulated fixture refresh failure' });
      if (fixtureState.delayFixtureMs) {
        setTimeout(respond, fixtureState.delayFixtureMs);
      } else {
        respond();
      }
      return;
    }
    if (relative === 'skills/http-error') {
      sendJson(res, 500, { message: 'simulated GitHub failure' });
      return;
    }
    if (relative === 'skills/slow') {
      setTimeout(() => sendJson(res, 200, [{
        name: 'SKILL.md',
        path: 'skills/slow/SKILL.md',
        type: 'file',
        size: 24,
      }]), 500);
      return;
    }
    if (relative === 'skills/slow/SKILL.md') {
      sendJson(res, 200, fileRecord(relative, '---\nname: Slow Skill\n---\n'));
      return;
    }
    if (relative === 'skills/traversal') {
      sendJson(res, 200, [{ name: '../escape', path: '../escape', type: 'file', size: 1 }]);
      return;
    }
    if (relative === 'skills/symlink') {
      sendJson(res, 200, [{ name: 'SKILL.md', path: 'skills/symlink/SKILL.md', type: 'symlink', size: 1 }]);
      return;
    }
    if (relative === 'skills/submodule') {
      sendJson(res, 200, [{
        name: 'SKILL.md',
        path: 'skills/submodule/SKILL.md',
        type: 'file',
        size: 1,
        submodule_git_url: 'https://github.com/other/repository.git',
      }]);
      return;
    }
    if (relative === 'skills/truncated') {
      sendJson(res, 200, Array.from({ length: 1000 }, (_, index) => ({
        name: `file-${String(index).padStart(4, '0')}.txt`,
        path: `skills/truncated/file-${String(index).padStart(4, '0')}.txt`,
        type: 'file',
        size: 1,
      })));
      return;
    }
    if (relative === 'skills/blob') {
      sendJson(res, 200, [
        { name: 'SKILL.md', path: 'skills/blob/SKILL.md', type: 'file', size: 24 },
        { name: 'large.bin', path: 'skills/blob/large.bin', type: 'file', size: 6 },
      ]);
      return;
    }
    if (relative === 'skills/blob/SKILL.md') {
      sendJson(res, 200, fileRecord(relative, '---\nname: Blob Skill\n---\n'));
      return;
    }
    if (relative === 'skills/blob/large.bin') {
      sendJson(res, 200, {
        name: 'large.bin',
        path: relative,
        type: 'file',
        size: 6,
        encoding: 'none',
        content: '',
        git_url: `http://${req.headers.host}/repos/owner/repo/git/blobs/blob-fixture`,
      });
      return;
    }
    if (relative === 'skills/missing') {
      sendJson(res, 200, [{ name: 'note.txt', path: 'skills/missing/note.txt', type: 'file', size: 4 }]);
      return;
    }
    if (relative === 'skills/missing/note.txt') {
      sendJson(res, 200, fileRecord(relative, 'note'));
      return;
    }
    if (relative === 'skills/redirect') {
      sendJson(res, 200, [{ name: 'SKILL.md', path: 'skills/redirect/SKILL.md', type: 'file', size: 25 }]);
      return;
    }
    if (relative === 'skills/redirect/SKILL.md') {
      res.writeHead(302, { Location: `http://127.0.0.1:${evilPortRef.port}/stolen` });
      res.end();
      return;
    }
    if (relative === 'skills/fixture') {
      const respond = () => sendJson(res, 200, [
        {
          name: 'SKILL.md',
          path: 'skills/fixture/SKILL.md',
          type: 'file',
          size: Buffer.byteLength(fixtureState.fixtureMarkdown || files.get('skills/fixture/SKILL.md')),
        },
        { name: 'assets', path: 'skills/fixture/assets', type: 'dir', size: 0 },
        { name: 'scripts', path: 'skills/fixture/scripts', type: 'dir', size: 0 },
      ]);
      if (fixtureState.delayFixtureMs) {
        setTimeout(respond, fixtureState.delayFixtureMs);
      } else {
        respond();
      }
      return;
    }
    if (relative === 'skills/fixture/assets') {
      sendJson(res, 200, [{
        name: 'data.bin',
        path: 'skills/fixture/assets/data.bin',
        type: 'file',
        size: files.get('skills/fixture/assets/data.bin').length,
      }]);
      return;
    }
    if (relative === 'skills/fixture/scripts') {
      const scriptContent = fixtureState.runScript || files.get('skills/fixture/scripts/run.js');
      sendJson(res, 200, [{
        name: 'run.js',
        path: 'skills/fixture/scripts/run.js',
        type: 'file',
        size: Buffer.byteLength(scriptContent),
      }]);
      return;
    }
    if (files.has(relative)) {
      const content = relative === 'skills/fixture/SKILL.md' && fixtureState.fixtureMarkdown
        ? fixtureState.fixtureMarkdown
        : relative === 'skills/fixture/scripts/run.js' && fixtureState.runScript
          ? fixtureState.runScript
          : files.get(relative);
      sendJson(res, 200, fileRecord(relative, content));
      return;
    }
    sendJson(res, 404, { message: 'not found' });
  });
}

function requestJson(port, method, pathname, body = null) {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: payload.length ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode || 0, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload.length) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForRelay(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`relay exited with code ${child.exitCode}`);
    }
    try {
      const health = await requestJson(port, 'GET', '/health');
      if (health.statusCode === 200) {
        return;
      }
    } catch (_) {
      // Retry until the isolated Relay is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('relay did not become ready');
}

async function stopChild(child) {
  if (!child || child.exitCode != null) {
    return;
  }
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function pollImport(port, importId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await requestJson(port, 'GET', `/api/skills/imports/${encodeURIComponent(importId)}`);
    assert.strictEqual(response.statusCode, 200);
    const state = response.body?.import?.state;
    if (state === 'completed' || state === 'failed') {
      return response.body.import;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('GitHub import did not finish');
}

async function waitForImportState(port, importId, expectedState) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await requestJson(port, 'GET', `/api/skills/imports/${encodeURIComponent(importId)}`);
    assert.strictEqual(response.statusCode, 200);
    if (response.body?.import?.state === expectedState) {
      return response.body.import;
    }
    if (response.body?.import?.state === 'completed' || response.body?.import?.state === 'failed') {
      throw new Error(`GitHub import reached ${response.body.import.state} before ${expectedState}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`GitHub import did not reach ${expectedState}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-skill-import-'));
  const evilPortRef = { port: 0 };
  const evilServer = http.createServer((req, res) => sendJson(res, 200, fileRecord('SKILL.md', 'stolen')));
  const fixtureState = {};
  const githubServer = createGithubFixtureServer(evilPortRef, fixtureState);
  let relay = null;
  try {
    evilPortRef.port = await listen(evilServer);
    const githubPort = await listen(githubServer);
    const apiBaseUrl = `http://127.0.0.1:${githubPort}`;

    assert.deepStrictEqual(normalizeGithubSkillSource({
      locator: 'owner/repo',
      ref: 'main',
      subpath: 'skills/fixture',
    }), {
      owner: 'owner',
      repo: 'repo',
      locator: 'owner/repo',
      ref: 'main',
      subpath: 'skills/fixture',
      sourceId: 'github:owner/repo:main:skills/fixture/SKILL.md',
      sourcePath: 'skills/fixture/SKILL.md',
    });
    assert.strictEqual(
      normalizeGithubSkillSource({ locator: 'https://github.com/owner/repo.git', ref: 'main', subpath: 'skills/fixture/SKILL.md' }).subpath,
      'skills/fixture'
    );
    assert.deepStrictEqual(
      normalizeGithubSkillSource({ locator: 'https://github.com/owner/repo/tree/main/skills/fixture' }),
      normalizeGithubSkillSource({ locator: 'owner/repo', ref: 'main', subpath: 'skills/fixture' })
    );

    const destination = path.join(root, 'downloaded');
    const downloaded = await downloadGithubSkill({
      locator: 'owner/repo',
      ref: 'main',
      subpath: 'skills/fixture',
      destination,
      apiBaseUrl,
      fetchImpl: fetch,
    });
    assert.strictEqual(downloaded.fileCount, 3);
    assert.strictEqual(downloaded.sourceId, 'github:owner/repo:main:skills/fixture/SKILL.md');
    assert(fs.existsSync(path.join(destination, 'SKILL.md')));
    assert(fs.existsSync(path.join(destination, 'scripts', 'run.js')));
    assert.deepStrictEqual(fs.readFileSync(path.join(destination, 'assets', 'data.bin')), Buffer.from([0, 1, 127, 128, 254, 255]));

    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/traversal', destination: path.join(root, 'traversal'), apiBaseUrl,
    }), /path|travers/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/symlink', destination: path.join(root, 'symlink'), apiBaseUrl,
    }), /symlink|unsupported/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/submodule', destination: path.join(root, 'submodule'), apiBaseUrl,
    }), /submodule|unsupported/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/truncated', destination: path.join(root, 'truncated'), apiBaseUrl,
    }), /1000|truncat|tree API/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/missing', destination: path.join(root, 'missing'), apiBaseUrl,
    }), /SKILL\.md/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/http-error', destination: path.join(root, 'error'), apiBaseUrl,
    }), /500|simulated GitHub failure/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/redirect', destination: path.join(root, 'redirect'), apiBaseUrl,
    }), /redirect|origin|repository API/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/fixture', destination: path.join(root, 'count'), apiBaseUrl, maxFiles: 2,
    }), /more than 2 files/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/fixture', destination: path.join(root, 'bytes'), apiBaseUrl, maxBytes: 4,
    }), /exceeds 4 bytes/i);
    await assert.rejects(downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/fixture', destination: path.join(root, 'depth'), apiBaseUrl, maxDepth: 0,
    }), /depth exceeds 0/i);
    await assert.rejects(
      Promise.resolve().then(() => normalizeGithubSkillSource({ locator: 'https://example.com/owner/repo' })),
      /GitHub/i
    );

    const blobDestination = path.join(root, 'blob');
    const blobDownloaded = await downloadGithubSkill({
      locator: 'owner/repo', ref: 'main', subpath: 'skills/blob', destination: blobDestination, apiBaseUrl,
    });
    assert.strictEqual(blobDownloaded.fileCount, 2);
    assert.deepStrictEqual(fs.readFileSync(path.join(blobDestination, 'large.bin')), Buffer.from([9, 8, 7, 6, 5, 4]));

    const relayPort = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close((error) => error ? reject(error) : resolve(port));
      });
    });
    const relayRoot = path.join(root, 'relay');
    fs.mkdirSync(relayRoot, { recursive: true });
    const output = [];
    const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(relayPort),
        RELAY_STATE_ROOT: relayRoot,
        RELAY_AUTH_DISABLED: 'true',
        RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
        RELAY_LOCAL_HOST_STUB: 'false',
        SKILL_GITHUB_API_BASE_URL: apiBaseUrl,
        SKILL_GITHUB_MAX_CONCURRENT_IMPORTS: '1',
        SESSION_COLLECTIONS_PATH: path.join(relayRoot, 'collections.json'),
        SESSION_METADATA_PATH: path.join(relayRoot, 'metadata.json'),
        SESSION_RECORD_STORE_ROOT: path.join(relayRoot, 'session-record-store'),
        SESSION_LOGS_PATH: path.join(relayRoot, 'logs.json'),
        SESSION_DIAGNOSTICS_PATH: path.join(relayRoot, 'diagnostics.json'),
        SKILL_FAVORITES_PATH: path.join(relayRoot, 'favorites.json'),
        SKILL_SOURCES_PATH: path.join(relayRoot, 'sources.json'),
        SKILL_LIBRARY_PATH: path.join(relayRoot, 'library.json'),
        SKILL_INVENTORIES_PATH: path.join(relayRoot, 'inventories.json'),
        SKILL_REGISTRY_PATH: path.join(relayRoot, 'registry.json'),
        SKILL_ARTIFACT_ROOT: path.join(relayRoot, 'artifacts'),
        SKILL_DEPLOYMENTS_PATH: path.join(relayRoot, 'deployments.json'),
        RELAY_AUTH_TOKEN_PATH: path.join(relayRoot, 'token.txt'),
        RELAY_AUTH_ACCOUNT_PATH: path.join(relayRoot, 'account.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relay = { child, output };
    child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
    await waitForRelay(relayPort, child);

    const queued = await requestJson(relayPort, 'POST', '/api/skills/import', {
      source: {
        kind: 'github',
        locator: 'owner/repo',
        ref: 'main',
        subpath: 'skills/fixture',
      },
    });
    assert.strictEqual(queued.statusCode, 202, JSON.stringify(queued.body));
    assert.strictEqual(queued.body?.state, 'queued');
    const completed = await pollImport(relayPort, queued.body.importId);
    assert.strictEqual(completed.state, 'completed', completed.error);
    assert.strictEqual(completed.skillId, 'fixture');
    assert(completed.artifactId?.startsWith('sha256:'));

    const skills = await requestJson(relayPort, 'GET', '/api/skills');
    assert(skills.body?.skillLibrary?.some((item) => item.skillId === 'fixture'));
    assert(skills.body?.sources?.some((item) => item.sourceId === 'github:owner/repo:main:skills/fixture/SKILL.md'));
    assert(skills.body?.artifacts?.some((item) => item.artifactId === completed.artifactId));

    const sourceId = 'github:owner/repo:main:skills/fixture/SKILL.md';
    const staleRefresh = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`,
      { expectedRevision: 0 }
    );
    assert.strictEqual(staleRefresh.statusCode, 409, JSON.stringify(staleRefresh.body));
    const sameRefresh = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`
    );
    assert.strictEqual(sameRefresh.statusCode, 202, JSON.stringify(sameRefresh.body));
    const sameCompleted = await pollImport(relayPort, sameRefresh.body.importId);
    assert.strictEqual(sameCompleted.state, 'completed', sameCompleted.error);
    assert.strictEqual(sameCompleted.artifactId, completed.artifactId);
    const afterSameRefresh = await requestJson(relayPort, 'GET', '/api/skills');
    const refreshedSource = afterSameRefresh.body.sources.find((source) => source.sourceId === sourceId);
    assert(refreshedSource.lastRefreshAt);
    assert.strictEqual(refreshedSource.lastError, null);
    assert.strictEqual(
      afterSameRefresh.body.skillLibrary.find((record) => record.skillId === 'fixture').artifactIds.length,
      1
    );

    fixtureState.runScript = '#!/usr/bin/env node\nconsole.log("fixture-v2");\n';
    const changedRefresh = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`
    );
    assert.strictEqual(changedRefresh.statusCode, 202, JSON.stringify(changedRefresh.body));
    const changedCompleted = await pollImport(relayPort, changedRefresh.body.importId);
    assert.strictEqual(changedCompleted.state, 'completed', changedCompleted.error);
    assert.notStrictEqual(changedCompleted.artifactId, completed.artifactId);
    const afterChangedRefresh = await requestJson(relayPort, 'GET', '/api/skills');
    const changedLibrary = afterChangedRefresh.body.skillLibrary.find((record) => record.skillId === 'fixture');
    assert.strictEqual(changedLibrary.latestArtifactId, changedCompleted.artifactId);
    assert.deepStrictEqual(
      new Set(changedLibrary.artifactIds),
      new Set([completed.artifactId, changedCompleted.artifactId])
    );
    assert.deepStrictEqual(afterChangedRefresh.body.deployments, []);

    fixtureState.delayFixtureMs = 400;
    const refreshFirst = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`
    );
    const refreshSecond = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`
    );
    assert.strictEqual(refreshFirst.statusCode, 202, JSON.stringify(refreshFirst.body));
    assert.strictEqual(refreshSecond.statusCode, 202, JSON.stringify(refreshSecond.body));
    assert.strictEqual(refreshSecond.body.importId, refreshFirst.body.importId);
    assert.strictEqual(refreshSecond.body.reused, true);
    await pollImport(relayPort, refreshFirst.body.importId);
    fixtureState.delayFixtureMs = 0;

    fixtureState.failFixture = true;
    const failedRefresh = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`
    );
    assert.strictEqual(failedRefresh.statusCode, 202, JSON.stringify(failedRefresh.body));
    const failedRefreshResult = await pollImport(relayPort, failedRefresh.body.importId);
    assert.strictEqual(failedRefreshResult.state, 'failed');
    const afterFailedRefresh = await requestJson(relayPort, 'GET', '/api/skills');
    assert.strictEqual(
      afterFailedRefresh.body.skillLibrary.find((record) => record.skillId === 'fixture').latestArtifactId,
      changedCompleted.artifactId
    );
    assert.match(
      afterFailedRefresh.body.sources.find((source) => source.sourceId === sourceId).lastError,
      /simulated fixture refresh failure/i
    );
    fixtureState.failFixture = false;

    fixtureState.failFixture = true;
    fixtureState.delayFixtureMs = 400;
    const overlappingImport = await requestJson(relayPort, 'POST', '/api/skills/import', {
      source: { kind: 'github', locator: 'owner/repo', ref: 'main', subpath: 'skills/fixture' },
    });
    assert.strictEqual(overlappingImport.statusCode, 202);
    await waitForImportState(relayPort, overlappingImport.body.importId, 'downloading');
    const overlappingRefresh = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`
    );
    assert.strictEqual(overlappingRefresh.statusCode, 202, JSON.stringify(overlappingRefresh.body));
    assert.strictEqual(overlappingRefresh.body.importId, overlappingImport.body.importId);
    assert.strictEqual(overlappingRefresh.body.reused, true);
    assert.strictEqual((await pollImport(relayPort, overlappingImport.body.importId)).state, 'failed');
    const afterOverlappingFailure = await requestJson(relayPort, 'GET', '/api/skills');
    assert.match(
      afterOverlappingFailure.body.sources.find((source) => source.sourceId === sourceId).lastError,
      /simulated fixture refresh failure/i
    );
    fixtureState.failFixture = false;
    fixtureState.delayFixtureMs = 0;

    const slowFirst = await requestJson(relayPort, 'POST', '/api/skills/import', {
      source: { kind: 'github', locator: 'owner/repo', ref: 'main', subpath: 'skills/slow' },
    });
    assert.strictEqual(slowFirst.statusCode, 202);
    await waitForImportState(relayPort, slowFirst.body.importId, 'downloading');
    const beforeCapacityFailure = await requestJson(relayPort, 'GET', '/api/skills');
    const capacityFailure = await requestJson(
      relayPort,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/refresh`,
      { expectedRevision: beforeCapacityFailure.body.registryRevision }
    );
    assert.strictEqual(capacityFailure.statusCode, 429, JSON.stringify(capacityFailure.body));
    assert(capacityFailure.body.revision > beforeCapacityFailure.body.registryRevision);
    const afterCapacityFailure = await requestJson(relayPort, 'GET', '/api/skills');
    assert.match(
      afterCapacityFailure.body.sources.find((source) => source.sourceId === sourceId).lastError,
      /concurrent|in progress/i
    );
    const slowSecond = await requestJson(relayPort, 'POST', '/api/skills/import', {
      source: { kind: 'github', locator: 'owner/repo', ref: 'main', subpath: 'skills/slow' },
    });
    assert.strictEqual(slowSecond.statusCode, 202);
    assert.strictEqual(slowSecond.body.importId, slowFirst.body.importId);
    assert.strictEqual(slowSecond.body.reused, true);
    assert.strictEqual((await pollImport(relayPort, slowFirst.body.importId)).state, 'completed');
  } catch (error) {
    if (relay?.output?.length) {
      error.message += `\nRelay output:\n${relay.output.join('').slice(-5000)}`;
    }
    throw error;
  } finally {
    await stopChild(relay?.child);
    await close(githubServer);
    await close(evilServer);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('GitHub Skill import assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
