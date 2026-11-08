'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'isolated-steer-host';
const SESSION = 'isolated-steer-session';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url,
      headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {} }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (s) => { text += s; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); } catch (e) { reject(e); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('test request timeout')));
    req.on('error', reject); req.end(bytes);
  });
}
async function waitFor(fn) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await fn(); if (value) return value; await delay(30); }
  throw new Error('isolated Relay fixture timed out');
}
async function main() {
  const probe = http.createServer();
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }));
  assert(![8797, 8897].includes(port));
  const root = fs.mkdtempSync(path.join(ROOT, 'tmp/steer-relay-'));
  const env = { ...process.env, PORT: String(port), RELAY_STATE_ROOT: root, RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false', RELAY_TEST_CONTROL_ENABLED: 'true',
    SESSION_RECORD_STORE_ROOT: path.join(root, 'session-record-store'), SKILL_ARTIFACT_ROOT: path.join(root, 'skill-artifacts') };
  for (const name of ['SESSION_COLLECTIONS', 'SESSION_METADATA', 'SESSION_LOGS', 'SESSION_DIAGNOSTICS', 'DISMISSED_HOSTS',
    'INPUT_COMMAND_OUTBOX', 'AGENT_EVENT_LEDGER', 'CONNECTORS', 'CONNECTOR_SECRETS', 'SKILL_FAVORITES', 'SKILL_SOURCES',
    'SKILL_LIBRARY', 'SKILL_INVENTORIES', 'SKILL_REGISTRY', 'SKILL_DEPLOYMENTS', 'SKILL_ADOPTIONS', 'SKILL_IMPORTS',
    'SKILL_REFRESHES', 'SKILL_AUDIT', 'THINKING_ACTIVITY']) env[`${name}_PATH`] = path.join(root, `${name.toLowerCase()}.json`);
  const child = spawn(process.execPath, ['apps/relay/server.js'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
  let polling = true; let cursor = 0; const commands = [];
  const event = (value) => request(port, 'POST', '/api/agent/events', { event: { hostId: HOST, ...value } });
  const poll = (async () => {
    while (polling) {
      try {
        const res = await request(port, 'GET', `/api/agent/commands?hostId=${HOST}&after=${cursor}&ack=${cursor}`);
        for (const cmd of res.body?.commands || []) {
          commands.push(cmd); cursor = Math.max(cursor, cmd.id);
          if (cmd.type === 'host.api_catalog') await event({ type: 'host.api_cataloged', requestId: cmd.requestId,
            bindingFingerprint: cmd.bindingFingerprint, runId: cmd.runId || null, result: { ok: true, statusCode: 200,
              modelPage: { authority: 'authoritative', complete: true, truncated: false, nextCursor: null, models: [{ id: 'steer-test-model', isDefault: true }] } } });
          if (cmd.type === 'host.binding_preflight') await event({ type: 'host.binding_preflighted', requestId: cmd.requestId, ok: true, binding: cmd.expectedBinding });
          if (cmd.type === 'session.start') await event({ type: 'session.started', sessionId: cmd.sessionId, nativeThreadId: cmd.sessionId,
            runId: cmd.runId, title: cmd.label, cwd: cmd.cwd, source: 'managed', launchMode: cmd.launchMode,
            conversationKey: cmd.conversationKey, effectiveBinding: cmd.expectedBinding,
            runtime: { adapterId: 'codex-app-server', runId: cmd.runId, nativeResumeReady: true, connection: 'ready',
              phase: 'thinking', busy: true, activeTurnId: 'turn-a', currentTurnStatus: 'inProgress' } });
        }
      } catch (_) {}
      await delay(20);
    }
  })();
  try {
    await waitFor(async () => { try { return (await request(port, 'GET', '/health')).body?.ok; } catch (_) { return false; } });
    assert.equal((await request(port, 'POST', '/api/agent/register', { hostId: HOST, label: 'Isolated steer fixture', platform: process.platform,
      capabilities: { apiCatalog: true, bindingPreflight: true, runApiBinding: true, sessionApiRebindV1: true, nativeResumeReadiness: true, managedStartPresenceV1: true, turnControls: true } })).status, 200);
    const started = await request(port, 'POST', `/api/hosts/${HOST}/sessions/start`, { sessionId: SESSION, cwd: root, label: 'Isolated Guide fixture',
      apiConfig: { profileId: 'fixture', label: 'fixture', provider: 'OpenAI', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fake-test-key' } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await waitFor(async () => (await request(port, 'GET', `/api/sessions/${SESSION}/runtime-config?hostId=${HOST}`)).body?.runStatus === 'live');
    await event({ type: 'session.runtime_updated', sessionId: SESSION, runId: started.body.runId,
      patch: { phase: 'thinking', busy: true, activeTurnId: 'turn-a', currentTurnStatus: 'inProgress' } });
    const route = `/api/sessions/${SESSION}/steer`;
    const target = { hostId: HOST, requestId: 'steer-request-a', expectedRunId: started.body.runId, expectedTurnId: 'turn-a', text: 'keep all context' };
    const lookup = (id = target.requestId) => request(port, 'GET', `${route}/${id}?hostId=${HOST}`);
    assert.equal((await request(port, 'POST', route, { hostId: HOST, text: 'missing identities' })).status, 400);
    assert.equal((await request(port, 'POST', route, { ...target, expectedTurnId: 'old' })).status, 409);
    assert.equal((await request(port, 'POST', route, { ...target, inputItems: [{ type: 'image' }] })).status, 400);
    assert.equal((await request(port, 'POST', route, { ...target, model: 'silently ignored model' })).status, 400);
    const queued = await request(port, 'POST', route, target);
    assert.equal(queued.status, 202, JSON.stringify(queued.body)); assert.equal(queued.body.status, 'queued');
    const duplicate = await request(port, 'POST', route, target);
    assert.equal(duplicate.body.commandId, queued.body.commandId);
    assert.equal((await request(port, 'POST', route, { ...target, text: 'different' })).status, 409);
    await waitFor(async () => commands.some((c) => c.type === 'session.steer'));
    assert.equal(commands.filter((c) => c.type === 'session.steer').length, 1);
    const receipt = { ...queued.body, type: 'session.steer_result', status: 'accepted', turnId: 'turn-a' };
    for (const key of ['sessionId', 'runId', 'expectedTurnId', 'requestId', 'commandId', 'turnId']) {
      await event({ ...receipt, [key]: key === 'commandId' ? receipt.commandId + 1 : 'wrong' });
      assert.equal((await lookup()).body.status, 'queued', key);
    }
    // An accepted receipt for the previous turn must not overwrite a new turn.
    await event({ type: 'session.runtime_updated', sessionId: SESSION, runId: target.expectedRunId,
      patch: { phase: 'thinking', busy: true, activeTurnId: 'turn-b', currentTurnStatus: 'inProgress' } });
    await event(receipt);
    assert.equal((await lookup()).body.status, 'accepted');
    const detail = await request(port, 'GET', `/api/sessions/${SESSION}/detail?hostId=${HOST}`);
    assert.equal((detail.body.runtime || detail.body.session.runtime).activeTurnId, 'turn-b');
    await event({ ...receipt, status: 'rejected', error: 'late error' });
    assert.equal((await lookup()).body.status, 'accepted');
    assert.equal((await request(port, 'POST', route, target)).body.status, 'accepted', 'old completed operation remains retrievable after turn changed');
    const second = await request(port, 'POST', route, { ...target, requestId: 'steer-request-b', expectedTurnId: 'turn-b' });
    assert.equal(second.status, 202);
    await event({ ...second.body, type: 'session.steer_result', status: 'acceptance_unknown', code: 'steer_acceptance_unknown' });
    assert.equal((await lookup('steer-request-b')).body.status, 'acceptance_unknown');
    console.log('Steer Relay isolated HTTP, identity, deduplication and late receipt integration tests passed');
  } catch (e) { e.message += `\n${logs}`; throw e; }
  finally {
    polling = false;
    if (child.exitCode == null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    await poll;
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
