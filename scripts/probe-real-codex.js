const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CODEX_BIN = process.env.CODEX_BIN
  || 'c:\\Users\\xiety\\.cursor\\extensions\\openai.chatgpt-26.5506.31421-win32-x64\\bin\\windows-x86_64\\codex.exe';
const CODEX_SUBCOMMAND = process.env.CODEX_SUBCOMMAND || 'app-server';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 30000);
const REQUEST_TIMEOUT_MS = Number(process.env.PROBE_REQUEST_TIMEOUT_MS || 10000);

async function main() {
  const child = spawn(CODEX_BIN, [CODEX_SUBCOMMAND], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const rpc = new JsonRpcSession(child);

  try {
    console.log(`[probe] spawned codex ${CODEX_SUBCOMMAND}`);

    console.log('[probe] initialize');
    const initialize = await rpc.request('initialize', {
      clientInfo: {
        name: 'mobile-codex-remote-probe',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }, REQUEST_TIMEOUT_MS);

    console.log('[probe] thread/start');
    const threadStart = await rpc.request('thread/start', {
      cwd: ROOT,
      sandbox: 'read-only',
      personality: 'friendly',
    }, REQUEST_TIMEOUT_MS);

    const threadId = threadStart?.thread?.id;
    if (!threadId) {
      throw new Error('thread/start did not return thread.id');
    }

    console.log(`[probe] thread ready ${threadId}`);
    console.log('[probe] turn/start');
    const turnStart = await rpc.request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: 'Reply with the exact text PONG and nothing else.',
        },
      ],
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'readOnly',
        networkAccess: false,
      },
    }, REQUEST_TIMEOUT_MS);

    const turnId = turnStart?.turn?.id;
    if (!turnId) {
      throw new Error('turn/start did not return turn.id');
    }

    console.log(`[probe] turn started ${turnId}`);
    const outcome = await rpc.waitForTurnCompletion(threadId, turnId, TIMEOUT_MS);
    const agentText = rpc.getAgentTextForTurn(turnId);

    console.log(JSON.stringify({
      ok: true,
      initialize,
      threadId,
      turnId,
      finalTurnStatus: outcome?.turn?.status || null,
      agentText,
      notifications: rpc.notificationSummary(),
      serverRequests: rpc.serverRequestSummary(),
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      notifications: rpc.notificationSummary(),
      serverRequests: rpc.serverRequestSummary(),
      agentTexts: rpc.agentTextSummary(),
    }, null, 2));
    throw error;
  } finally {
    rpc.dispose();
    child.kill();
  }
}

class JsonRpcSession {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationLog = [];
    this.serverRequests = [];
    this.turnWaiters = new Map();
    this.agentDeltas = new Map();
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) {
        this.notificationLog.push({
          method: 'stderr',
          sample: text.slice(0, 500),
        });
      }
    });
    child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`codex remote-control exited early: ${code ?? 'null'} / ${signal ?? 'null'}`));
      }
      this.pending.clear();
    });
  }

  dispose() {
    for (const [key, waiter] of this.turnWaiters.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`aborted while waiting for ${key}`));
      this.turnWaiters.delete(key);
    }
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const text = `${JSON.stringify(payload)}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(text, 'utf8', (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  waitForTurnCompletion(threadId, turnId, timeoutMs) {
    const key = `${threadId}::${turnId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(new Error(`Timed out while waiting for turn completion: ${key}`));
      }, timeoutMs);
      this.turnWaiters.set(key, { resolve, reject, timer });
    });
  }

  getAgentTextForTurn(turnId) {
    return Array.from(this.agentDeltas.entries())
      .filter(([key]) => key.endsWith(`::${turnId}`) || key.includes(`::${turnId}::`))
      .map(([, value]) => value)
      .join('');
  }

  notificationSummary() {
    return this.notificationLog.map((entry) => ({
      method: entry.method,
      threadId: entry.threadId || null,
      turnId: entry.turnId || null,
      itemId: entry.itemId || null,
      sample: entry.sample || null,
    }));
  }

  serverRequestSummary() {
    return this.serverRequests.map((entry) => ({
      method: entry.method,
      id: entry.id,
      sample: entry.sample,
    }));
  }

  agentTextSummary() {
    return Array.from(this.agentDeltas.entries()).map(([key, value]) => ({
      key,
      text: value,
    }));
  }

  onStdout(chunk) {
    this.buffer += chunk;

    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n');
      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!rawLine) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(rawLine);
      } catch (error) {
        this.notificationLog.push({
          method: 'stdout.raw',
          sample: rawLine.slice(0, 500),
        });
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'result')) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'error')) {
      const pending = this.pending.get(message.id);
      const error = new Error(message.error?.message || `JSON-RPC error for ${message.id}`);
      if (pending) {
        this.pending.delete(message.id);
        pending.reject(error);
      } else {
        this.notificationLog.push({
          method: 'jsonrpc.error',
          sample: JSON.stringify(message.error).slice(0, 500),
        });
      }
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params || {};

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.serverRequests.push({
        id: message.id,
        method: message.method,
        sample: JSON.stringify(params).slice(0, 500),
      });
      return;
    }

    this.notificationLog.push({
      method: message.method,
      threadId: params.threadId || params.thread?.id || null,
      turnId: params.turnId || params.turn?.id || null,
      itemId: params.itemId || params.item?.id || null,
      sample: summarizeParams(params),
    });

    if (message.method === 'item/agentMessage/delta') {
      const key = `${params.threadId}::${params.turnId}::${params.itemId}`;
      const previous = this.agentDeltas.get(key) || '';
      this.agentDeltas.set(key, `${previous}${params.delta || ''}`);
      return;
    }

    if (message.method === 'turn/completed') {
      const key = `${params.threadId}::${params.turn?.id || params.turnId}`;
      const waiter = this.turnWaiters.get(key);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.turnWaiters.delete(key);
        waiter.resolve(params);
      }
    }
  }
}

function summarizeParams(params) {
  const text = JSON.stringify(params);
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
