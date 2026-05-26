const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8792;
const RELAY_URL = `http://127.0.0.1:${PORT}`;
const RELAY_AUTH_TOKEN = 'managed-test-relay-token';
const RELAY_AUTH_ACCOUNT_PATH = path.join(ROOT, 'tmp', 'runtime', `managed-test-auth-account-${process.pid}.json`);
const HOST_ID = 'managed-test-host';
const HOST_LABEL = 'Managed Test Host';

async function main() {
  const relay = spawnNode(path.join(ROOT, 'apps', 'relay', 'server.js'), {
    ...process.env,
    PORT: String(PORT),
    RELAY_AUTH_TOKEN,
    RELAY_AUTH_ACCOUNT_PATH,
  });

  const agent = spawnNode(path.join(ROOT, 'apps', 'host-agent', 'agent.js'), {
    ...process.env,
    RELAY_URL,
    RELAY_AUTH_TOKEN,
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
    const setupState = await getJsonNoAuth('/api/auth/config');
    if (!setupState.setupRequired) {
      throw new Error('relay auth account setup should be required in isolated test');
    }
    await postJsonNoAuth('/api/auth/setup', {
      username: 'admin',
      password: 'managed-test-password',
      confirmPassword: 'managed-test-password',
    });
    await postJsonNoAuth('/api/auth/login', {
      username: 'admin',
      password: 'managed-test-password',
    });

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

    const uploadText = `remote-file-smoke-${Date.now()}`;
    const uploadDirectory = path.join(ROOT, 'tmp');
    fs.mkdirSync(uploadDirectory, { recursive: true });
    const upload = await postJson(`/api/hosts/${encodeURIComponent(session.hostId)}/files/upload`, {
      sessionId: session.sessionId,
      targetDirectory: uploadDirectory,
      files: [{
        name: 'managed-smoke.txt',
        mime: 'text/plain',
        size: Buffer.byteLength(uploadText),
        dataBase64: Buffer.from(uploadText).toString('base64'),
      }],
    });
    const uploadedFile = upload.files && upload.files[0];
    if (!uploadedFile?.path) {
      throw new Error('file upload did not return a remote path');
    }
    const downloaded = await getBuffer(`/api/hosts/${encodeURIComponent(session.hostId)}/files/download?sessionId=${encodeURIComponent(session.sessionId)}&path=${encodeURIComponent(uploadedFile.path)}`);
    if (downloaded.toString('utf8') !== uploadText) {
      throw new Error('downloaded file content did not match uploaded content');
    }
    const received = await getJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/received-files?hostId=${encodeURIComponent(session.hostId)}`);
    const receivedFile = (received.files || []).find((file) => file.remotePath === uploadedFile.path);
    if (!receivedFile?.fileId) {
      throw new Error('downloaded file was not cached in the relay received-files inbox');
    }
    const cached = await getBuffer(`/api/received-files/${encodeURIComponent(receivedFile.fileId)}`);
    if (cached.toString('utf8') !== uploadText) {
      throw new Error('cached received file content did not match uploaded content');
    }

    const stats = await getJson('/api/stats');

    console.log(JSON.stringify({
      ok: true,
      relayUrl: RELAY_URL,
      hostId: session.hostId,
      sessionId: session.sessionId,
      matchedOutput: matched.data.chunk,
      fileTransfer: {
        uploadedPath: uploadedFile.path,
        downloadedBytes: downloaded.length,
        receivedFileId: receivedFile.fileId,
      },
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
        Authorization: `Bearer ${RELAY_AUTH_TOKEN}`,
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
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error(`timeout after ${timeoutMs}ms`);
}

async function getJson(pathname) {
  const response = await fetch(`${RELAY_URL}${pathname}`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed with ${response.status}`);
  }
  return response.json();
}

async function getJsonNoAuth(pathname) {
  const response = await fetch(`${RELAY_URL}${pathname}`);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `GET ${pathname} failed with ${response.status}`);
  }
  return json;
}

async function getBuffer(pathname) {
  const response = await fetch(`${RELAY_URL}${pathname}`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch (_) {
      errorText = '';
    }
    throw new Error(`GET ${pathname} failed with ${response.status}${errorText ? `: ${errorText}` : ''}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function postJson(pathname, body) {
  const response = await fetch(`${RELAY_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `POST ${pathname} failed with ${response.status}`);
  }
  return json;
}

async function postJsonNoAuth(pathname, body) {
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

function authHeaders() {
  return {
    Authorization: `Bearer ${RELAY_AUTH_TOKEN}`,
  };
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
