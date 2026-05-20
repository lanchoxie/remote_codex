const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8792;
const RELAY_URL = `http://127.0.0.1:${PORT}`;
const HOST_ID = 'managed-test-host';
const HOST_LABEL = 'Managed Test Host';

async function main() {
  const relay = spawnNode(path.join(ROOT, 'apps', 'relay', 'server.js'), {
    ...process.env,
    PORT: String(PORT),
  });

  const agent = spawnNode(path.join(ROOT, 'apps', 'host-agent', 'agent.js'), {
    ...process.env,
    RELAY_URL,
    HOST_ID,
    HOST_LABEL,
    AUTO_START_SESSION: 'true',
    MANAGED_COMMAND: 'demo',
    MANAGED_CWD: ROOT,
    DISCOVERY_INTERVAL_MS: '60000',
    POLL_INTERVAL_MS: '500',
  });

  let sseRequest = null;

  try {
    await waitForHealth();
    const session = await waitForLiveManagedSession();
    const transcript = [];
    sseRequest = subscribeToSession(session.hostId, session.sessionId, transcript);

    const prompt = `android-ui-smoke-${Date.now()}`;
    await postJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/input`, {
      hostId: session.hostId,
      text: prompt,
    });

    const matched = await waitForTranscriptLine(
      transcript,
      (entry) => entry.type === 'session.output' && String(entry.data.chunk || '').includes(prompt),
      8000
    );
    const stats = await getJson('/api/stats');

    console.log(JSON.stringify({
      ok: true,
      relayUrl: RELAY_URL,
      hostId: session.hostId,
      sessionId: session.sessionId,
      matchedOutput: matched.data.chunk,
      stats: {
        totalHosts: stats.summary.totalHosts,
        liveSessions: stats.summary.liveSessions,
        managedSessions: stats.summary.managedSessions,
      },
    }, null, 2));
  } finally {
    if (sseRequest) {
      sseRequest.destroy();
    }
    await stopProcess(agent);
    await stopProcess(relay);
  }
}

function spawnNode(scriptPath, env) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${path.basename(scriptPath)}] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${path.basename(scriptPath)}] ${chunk}`);
  });

  return child;
}

async function waitForHealth() {
  await waitFor(async () => {
    const response = await getJson('/health');
    return response.ok ? response : null;
  }, 5000, 200);
}

async function waitForLiveManagedSession() {
  return waitFor(async () => {
    const hosts = await getJson('/api/hosts');
    const host = (hosts.hosts || []).find((item) => item.hostId === HOST_ID);
    if (!host) {
      return null;
    }

    const sessions = await getJson(`/api/hosts/${encodeURIComponent(HOST_ID)}/sessions`);
    return (sessions.sessions || []).find((session) => session.source === 'managed' && session.live === true) || null;
  }, 8000, 250);
}

function subscribeToSession(hostId, sessionId, transcript) {
  const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/events?hostId=${encodeURIComponent(hostId)}`, RELAY_URL);
  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
      },
    },
    (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      let currentEvent = 'message';

      res.on('data', (chunk) => {
        buffer += chunk;

        while (buffer.includes('\n\n')) {
          const index = buffer.indexOf('\n\n');
          const rawEvent = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const lines = rawEvent.split('\n');
          let dataText = '';
          currentEvent = 'message';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice('event:'.length).trim();
            } else if (line.startsWith('data:')) {
              dataText += line.slice('data:'.length).trim();
            }
          }

          if (!dataText) {
            continue;
          }

          try {
            transcript.push({
              type: currentEvent,
              data: JSON.parse(dataText),
            });
          } catch (_) {
            transcript.push({
              type: currentEvent,
              data: { raw: dataText },
            });
          }
        }
      });
    }
  );

  req.on('error', (error) => {
    transcript.push({
      type: 'stream.error',
      data: { message: error.message },
    });
  });
  req.end();
  return req;
}

async function waitForTranscriptLine(transcript, predicate, timeoutMs) {
  return waitFor(() => transcript.find(predicate) || null, timeoutMs, 100);
}

async function waitFor(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

async function getJson(pathname) {
  const response = await fetch(`${RELAY_URL}${pathname}`);
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed with ${response.status}`);
  }
  return response.json();
}

async function postJson(pathname, body) {
  const response = await fetch(`${RELAY_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `POST ${pathname} failed with ${response.status}`);
  }
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2000).then(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
