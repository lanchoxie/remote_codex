const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const relayPath = path.join(ROOT, 'apps', 'relay', 'server.js');
const relay = fs.readFileSync(relayPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const saveStart = relay.indexOf('function saveSessionDiagnostics()');
const saveEnd = relay.indexOf('let sessionLogsSaveTimer', saveStart);
assert(saveStart >= 0 && saveEnd > saveStart, 'relay should define saveSessionDiagnostics before save timers');
const saveBody = relay.slice(saveStart, saveEnd);

assert(
  !/writeFileSync\s*\(\s*SESSION_DIAGNOSTICS_PATH/.test(saveBody),
  'saveSessionDiagnostics should not synchronously rewrite the full diagnostics file on hot paths'
);
assert(
  /sessionDiagnosticsSaveInFlight/.test(relay),
  'relay should serialize async diagnostics writes with sessionDiagnosticsSaveInFlight'
);
assert(
  /sessionDiagnosticsSavePending/.test(relay),
  'relay should coalesce diagnostics saves with sessionDiagnosticsSavePending'
);
assert(
  /fs\.promises\.writeFile\s*\(\s*SESSION_DIAGNOSTICS_PATH/.test(relay),
  'relay should persist session diagnostics with fs.promises.writeFile'
);

console.log('relay diagnostics persistence assertions passed');
