const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'apps/mobile-web/public/app.js'), 'utf8');

function assertIncludes(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nMissing: ${needle}`
  );
}

assertIncludes(
  app,
  'function clearSkillOptionsCacheForHosts',
  'Client should expose a helper to clear slash skill options for affected hosts'
);

assertIncludes(
  app,
  'clearSkillOptionsCacheForHosts(hostIds)',
  'Skills install/uninstall should invalidate slash skill cache for affected hosts'
);

assertIncludes(
  app,
  'state.codexControls.skillOptionsRetryAfterBySession.delete(key)',
  'Cache invalidation should also clear slash skill retry cooldowns'
);

assertIncludes(
  app,
  "loadSkillOptionsForSession(selected, { force: true })",
  'After invalidation, the selected live session should force reload skills for the slash menu'
);

assertIncludes(
  app,
  'recentSkillChangesByHost: new Set()',
  'Client should track hosts with recent skills install/uninstall changes'
);

assertIncludes(
  app,
  'state.codexControls.recentSkillChangesByHost.add(hostId)',
  'Skills install/uninstall should mark affected hosts for the next slash-menu skill reload'
);

assertIncludes(
  app,
  'const forceSkillReload = consumeRecentSkillChangeForSession(getSelectedSession())',
  'Slash menu opening should consume recent skill changes for the selected session'
);

assertIncludes(
  app,
  'requestSkillOptionsForSession(getSelectedSession(), { force: forceSkillReload })',
  'Slash menu opening should force reload skills after recent install/uninstall changes'
);

assertIncludes(
  app,
  "forceReload=true",
  'Session skill list requests should support forceReload=true'
);

console.log('slash skills cache invalidation contract ok');
