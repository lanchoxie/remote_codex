const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { discoverCodexSessions } = require('../shared/codex-discovery');

const ROOT = path.join(__dirname, '..');
const PORT = 8792;
const RELAY_URL = `http://127.0.0.1:${PORT}`;
const RELAY_AUTH_TOKEN = 'managed-test-relay-token';
const RELAY_AUTH_ACCOUNT_PATH = path.join(ROOT, 'tmp', 'runtime', `managed-test-auth-account-${process.pid}.json`);
const HOST_ID = 'managed-test-host';
const HOST_LABEL = 'Managed Test Host';

async function main() {
  verifyCodexDiscoveryFormats();

  const relay = spawnNode(path.join(ROOT, 'apps', 'relay', 'server.js'), {
    ...process.env,
    PORT: String(PORT),
    RELAY_AUTH_TOKEN,
    RELAY_AUTH_ACCOUNT_PATH,
  });

  let agent = null;
  let sseRequest = null;

  try {
    await waitForHealth();
    agent = spawnNode(path.join(ROOT, 'apps', 'host-agent', 'agent.js'), {
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
      15000
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

    const chunkedBytes = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let index = 0; index < chunkedBytes.length; index += 1) {
      chunkedBytes[index] = index % 251;
    }
    const chunkedBegin = await postJson(`/api/hosts/${encodeURIComponent(session.hostId)}/files/uploads`, {
      sessionId: session.sessionId,
      targetDirectory: uploadDirectory,
      name: 'managed-chunked.bin',
      mime: 'application/octet-stream',
      size: chunkedBytes.length,
      chunkSize: 1024 * 1024,
    });
    let chunkedOffset = 0;
    let chunkedIndex = 0;
    while (chunkedOffset < chunkedBytes.length) {
      const end = Math.min(chunkedOffset + chunkedBegin.chunkSize, chunkedBytes.length);
      const chunk = await postJson(`/api/hosts/${encodeURIComponent(session.hostId)}/files/uploads/${encodeURIComponent(chunkedBegin.uploadId)}/chunks`, {
        index: chunkedIndex,
        offset: chunkedOffset,
        dataBase64: chunkedBytes.subarray(chunkedOffset, end).toString('base64'),
      });
      chunkedOffset = chunk.receivedBytes;
      chunkedIndex += 1;
    }
    const chunkedComplete = await postJson(`/api/hosts/${encodeURIComponent(session.hostId)}/files/uploads/${encodeURIComponent(chunkedBegin.uploadId)}/complete`, {});
    const chunkedFile = chunkedComplete.files && chunkedComplete.files[0];
    if (!chunkedFile?.path) {
      throw new Error('chunked upload did not return a remote path');
    }
    const chunkedDownloaded = await getBuffer(`/api/hosts/${encodeURIComponent(session.hostId)}/files/download?sessionId=${encodeURIComponent(session.sessionId)}&path=${encodeURIComponent(chunkedFile.path)}&chunked=1`);
    if (!chunkedDownloaded.equals(chunkedBytes)) {
      throw new Error('chunked downloaded file content did not match uploaded content');
    }

    const migration = await verifyBridgeSessionMigration();

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
        chunkedUploadedPath: chunkedFile.path,
        chunkedDownloadedBytes: chunkedDownloaded.length,
      },
      bridgeMigration: migration,
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

function verifyCodexDiscoveryFormats() {
  const sessionId = '019efeed-1234-7abc-8def-0123456789ab';
  const codexHome = path.join(ROOT, 'tmp', 'runtime', `discovery-smoke-${process.pid}`);
  const sessionDir = path.join(codexHome, 'sessions', '2026', '05', '27');
  fs.mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = path.join(sessionDir, `rollout-2026-05-27T12-30-00-${sessionId}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: '2026-05-27T04:30:00.000Z',
      type: 'turn_context',
      payload: {
        cwd: '/hpc/project/discovery-smoke',
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-27T04:31:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'find my missing hpc conversation' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-27T04:32:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'found from fallback rollout parsing' }],
      },
    }),
    '',
  ].join('\n'));

  const sessions = discoverCodexSessions({ codexHome });
  const session = sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    throw new Error('discovery did not import rollout without session_meta');
  }
  if (session.cwd !== '/hpc/project/discovery-smoke') {
    throw new Error('discovery did not infer cwd from turn_context');
  }
  if (session.latestUserMessage !== 'find my missing hpc conversation') {
    throw new Error('discovery did not parse response_item user message');
  }
  if (session.latestAgentMessage !== 'found from fallback rollout parsing') {
    throw new Error('discovery did not parse response_item assistant message');
  }
}

async function verifyBridgeSessionMigration() {
  const fakeHostId = `${HOST_ID}-native-migration`;
  const nativeSessionId = `native-thread-${Date.now()}`;
  await postJson('/api/agent/register', {
    hostId: fakeHostId,
    label: 'Native Migration Test Host',
    platform: process.platform,
    capabilities: { managedSessions: true },
  });

  const start = await postJson(`/api/hosts/${encodeURIComponent(fakeHostId)}/sessions/start`, {
    cwd: ROOT,
    label: 'native migration smoke',
    launchMode: 'fresh',
    apiConfig: {
      label: 'Migration API',
      provider: 'test',
      baseUrl: 'http://example.invalid/v1',
      apiKey: 'test-key-not-used',
      profileId: 'migration-api',
    },
  });
  if (!start.sessionId) {
    throw new Error('start response did not include bridge session id');
  }

  await postJson('/api/agent/events', {
    event: {
      type: 'session.started',
      hostId: fakeHostId,
      sessionId: nativeSessionId,
      bridgeSessionId: start.sessionId,
      nativeThreadId: nativeSessionId,
      title: 'native migration smoke',
      cwd: ROOT,
      source: 'managed',
      launchMode: 'fresh',
      runtime: {
        kind: 'codex-app-server',
        threadId: nativeSessionId,
        phase: 'idle',
      },
    },
  });

  const sessions = await getJson(`/api/hosts/${encodeURIComponent(fakeHostId)}/sessions`);
  const migrated = (sessions.sessions || []).find((item) => item.sessionId === nativeSessionId);
  if (!migrated?.live) {
    throw new Error('bridge session did not migrate to a live native session');
  }
  if (migrated.bridgeSessionId !== start.sessionId) {
    throw new Error('migrated session did not keep its bridgeSessionId');
  }
  if (migrated.apiProfile?.label !== 'Migration API') {
    throw new Error('migrated session did not preserve its API profile summary');
  }
  return {
    bridgeSessionId: start.sessionId,
    nativeSessionId,
    apiProfile: migrated.apiProfile.label,
  };
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
  }, 20000, 250);
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
