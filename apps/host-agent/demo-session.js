const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

const bootstrap = parseBootstrap();

console.log('[demo] session ready');
console.log('[demo] type a message and press enter');
emitBootstrapPreview(bootstrap);

function parseBootstrap() {
  const raw = process.env.DEMO_BOOTSTRAP_JSON || '';
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function emitBootstrapPreview(payload) {
  if (!payload || payload.launchMode === 'fresh') {
    return;
  }

  console.log(`[demo] ${payload.summary || 'restored context loaded'}`);
  const preview = Array.isArray(payload.historyPreview) ? payload.historyPreview.length : 0;
  if (preview > 0) {
    console.log(`[demo] loaded ${preview} history preview messages`);
  }
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) {
    return;
  }

  if (text === '/exit' || text === '/stop') {
    console.log('[demo] stopping');
    process.exit(0);
  }

  console.log(`[demo] transport received: ${text}`);
  console.log(`[assistant] continuing work on: ${text}`);
  console.log('[demo] no real Codex model is attached to this managed session yet');
});
