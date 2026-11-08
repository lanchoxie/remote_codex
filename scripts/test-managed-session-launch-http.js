const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'apps/mobile-web/public');
const names = ['managed-session-launch.js', 'managed-session-launch-coordinator.js', 'managed-session-launch-storage.js'];
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(file => file && fs.existsSync(file));

async function main() {
  const requests = new Map();
  let activeRun = 'parent-run';
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/start' || req.url === '/rebind') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const key = body.clientRequestId;
      let result = requests.get(key);
      if (!result && req.url === '/rebind' && body.expectedRunId !== activeRun) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'session_run_changed' }));
        return;
      }
      if (!result) {
        result = { hostId: 'fixture', sessionId: `session-${key}`, runId: `run-${key}`, clientRequestId: key };
        requests.set(key, result);
        if (req.url === '/rebind') activeRun = result.runId;
      }
      if (body.slow) await slow;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    const filename = req.url.slice(1);
    if (names.includes(filename)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(fs.readFileSync(path.join(publicRoot, filename)));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>Isolated HTTP launch fixture</title>${names.map(name => `<script src="/${name}"></script>`).join('')}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}),
    args: ['--host-resolver-rules=MAP launch-test.invalid 127.0.0.1', '--no-proxy-server'] });
  const context = await browser.newContext();
  const setup = async (page, origin = `http://launch-test.invalid:${port}`) => {
    await page.goto(origin);
    await page.evaluate(() => {
      window.launchStorage = RemoteCodexManagedSessionLaunchStorage.createLaunchStorage();
      window.coordinator = RemoteCodexManagedSessionLaunchCoordinator.createManagedSessionLaunchCoordinator({
        readLedger: () => launchStorage.readLedger(),
        mutateLedger: update => launchStorage.mutateLedger(update),
        observe: async () => ({ status: 'pending', terminal: false }),
      });
      window.makeReceipt = (id, extra = {}) => {
        const acceptedAtMs = Date.now();
        return { version: 1, hostId: 'fixture', sessionId: `session-${id}`, runId: `run-${id}`,
          acceptedAtMs, acceptedAt: new Date(acceptedAtMs).toISOString(), ...extra };
      };
      window.submit = async ({ intent, id, startedAtMs, slow = false, expectedRunId = null }) => {
        return launchStorage.withIntent(intent, async () => {
          const claim = await launchStorage.claimIntent(intent, id, startedAtMs, expectedRunId ? { expectedRunId } : null);
          const response = await fetch(expectedRunId ? '/rebind' : '/start', { method: 'POST',
            body: JSON.stringify({ clientRequestId: claim.clientRequestId, slow, ...(claim.expectation || {}) }) });
          const result = await response.json();
          if (!response.ok) throw Object.assign(new Error(result.code), { code: result.code });
          await coordinator.mergeReceipts([makeReceipt(claim.clientRequestId, { intentKey: intent, clientRequestId: claim.clientRequestId })]);
          return result;
        });
      };
    });
  };
  try {
    const a = await context.newPage();
    const b = await context.newPage();
    await Promise.all([setup(a), setup(b)]);
    assert.deepStrictEqual(await a.evaluate(() => ({ secure: isSecureContext, locks: Boolean(navigator.locks) })), { secure: false, locks: false });

    // Import old receipts once without touching API profiles or the legacy copy.
    const legacy = await a.evaluate(() => {
      const raw = JSON.stringify({ version: 1, receipts: [makeReceipt('legacy')] });
      localStorage.setItem('mobile-codex-remote.session-launch-receipts.v1', raw);
      localStorage.setItem('mobile-codex-remote.ui-settings.v1', 'API settings sentinel');
      return raw;
    });
    await Promise.all([a.evaluate(() => coordinator.restore({ track: false })), b.evaluate(() => coordinator.restore({ track: false }))]);
    assert.strictEqual(await b.evaluate(() => localStorage.getItem('mobile-codex-remote.session-launch-receipts.v1')), legacy);

    const startedAtMs = Date.now();
    const pair = await Promise.all([
      a.evaluate(args => submit(args), { intent: 'same-intent', id: 'one', startedAtMs }),
      b.evaluate(args => submit(args), { intent: 'same-intent', id: 'two', startedAtMs }),
    ]);
    assert.strictEqual(pair[0].runId, pair[1].runId);
    assert.strictEqual(requests.size, 1, 'same HTTP intent creates one server run');

    // Contending ledger writes retain every independently accepted receipt.
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).evaluate(id => coordinator.mergeReceipts([makeReceipt(id)]), `parallel-${i}`)));
    const ledger = await a.evaluate(() => coordinator.readLedger());
    assert.strictEqual(ledger.receipts.length, 14);
    const terminal = await Promise.all([a.evaluate(() => coordinator.removeReceipt(makeReceipt('parallel-0'))), b.evaluate(() => coordinator.removeReceipt(makeReceipt('parallel-0')))]);
    assert.strictEqual(terminal.filter(result => result.removed).length, 1, 'terminal receipt has one atomic claimant');

    const originalId = pair[0].clientRequestId;
    // Receipt deletion must also persist completion before any UI callback or
    // page shutdown. No separate completeIntent call repairs this transition.
    await a.evaluate(id => coordinator.removeReceipt(makeReceipt(id)), originalId);
    await a.reload();
    const late = await b.evaluate(args => launchStorage.claimIntent('same-intent', 'late', args), startedAtMs);
    assert.strictEqual(late.clientRequestId, originalId, 'late click reuses completed generation');
    assert(late.completedAtMs, 'receipt removal atomically terminalizes the matching intent');
    const fresh = await b.evaluate(async () => {
      const saved = await launchStorage.claimIntent('same-intent', 'late-probe', Date.now() - 1_000);
      return launchStorage.claimIntent('same-intent', 'explicit-new', saved.completedAtMs + 1);
    });
    assert.strictEqual(fresh.clientRequestId, 'explicit-new', 'new click after completion starts another generation');
    await setup(a);

    // Holding a network request never holds an IDB transaction or another intent.
    const slowPage = await context.newPage();
    await setup(slowPage);
    const slowResult = slowPage.evaluate(args => submit(args), { intent: 'slow-intent', id: 'slow-one', startedAtMs: Date.now(), slow: true }).catch(() => null);
    await a.waitForFunction(() => true);
    for (let i = 0; !requests.has('slow-one') && i < 100; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert(requests.has('slow-one'));
    const independent = await Promise.race([
      b.evaluate(args => submit(args), { intent: 'other-intent', id: 'other', startedAtMs: Date.now() }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('unrelated intent was blocked')), 2_000)),
    ]);
    assert.strictEqual(independent.clientRequestId, 'other');
    await slowPage.close();
    await slowResult;
    const recovered = await b.evaluate(args => submit(args), { intent: 'slow-intent', id: 'must-not-be-used', startedAtMs: Date.now() });
    assert.strictEqual(recovered.clientRequestId, 'slow-one', 'closed tab submission is recovered using its durable ID');
    releaseSlow();

    // Rebind callers retain the first observed expected-run fence and stable ID.
    const rebinding = await Promise.all([
      a.evaluate(args => submit(args), { intent: 'rebind-intent', id: 'rebind-one', startedAtMs: Date.now(), expectedRunId: 'parent-run' }),
      b.evaluate(args => submit(args), { intent: 'rebind-intent', id: 'rebind-two', startedAtMs: Date.now(), expectedRunId: 'parent-run' }),
    ]);
    assert.strictEqual(rebinding[0].runId, rebinding[1].runId);
    const fence = await b.evaluate(() => launchStorage.claimIntent('rebind-intent', 'changed', Date.now(), { expectedRunId: 'newer-parent' }));
    assert.strictEqual(fence.expectation.expectedRunId, 'parent-run');
    const conflict = await a.evaluate(async () => {
      try { await submit({ intent: 'different-rebind', id: 'different', startedAtMs: Date.now(), expectedRunId: 'parent-run' }); }
      catch (error) { return error.code; }
    });
    assert.strictEqual(conflict, 'session_run_changed');

    // A failed atomic update never erases prior receipts or unrelated settings.
    const failureState = await a.evaluate(async () => {
      const before = await launchStorage.readLedger();
      try { await launchStorage.mutateLedger(() => { throw new Error('injected write failure'); }); } catch (_) {}
      return { preserved: before === await launchStorage.readLedger(), api: localStorage.getItem('mobile-codex-remote.ui-settings.v1') };
    });
    assert.deepStrictEqual(failureState, { preserved: true, api: 'API settings sentinel' });

    // HTTPS/localhost retains browser-owned asynchronous locking when available.
    const secure = await context.newPage();
    await setup(secure, `http://127.0.0.1:${port}`);
    assert.strictEqual(await secure.evaluate(() => Boolean(navigator.locks)), true);
    const webLock = await secure.evaluate(async () => {
      let active = 0;
      let max = 0;
      await Promise.all([1, 2].map(() => launchStorage.withIntent('native-lock', async () => {
        active += 1; max = Math.max(max, active);
        await new Promise(resolve => setTimeout(resolve, 25)); active -= 1;
      })));
      return max;
    });
    assert.strictEqual(webLock, 1);
    console.log('HTTP launch coordination passed: non-secure origin, concurrent intents, atomic receipts, late clicks, closed-tab recovery, rebind fencing, preserved storage, Web Locks priority');
  } finally {
    releaseSlow();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
