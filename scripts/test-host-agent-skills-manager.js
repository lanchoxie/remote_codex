const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const agent = fs.readFileSync(path.join(root, 'apps/host-agent/agent.js'), 'utf8');

function mustContain(needle, message) {
  assert(agent.includes(needle), `${message}\nMissing: ${needle}`);
}

mustContain('function listInstalledSkills', 'host-agent should scan installed skills without a live session');
mustContain('function normalizeSkillId', 'host-agent should validate skill ids before filesystem operations');
mustContain('function ensureSafeSkillPath', 'host-agent should prevent skill path traversal');
mustContain('function installHostSkill', 'host-agent should support host-level skill install');
mustContain('function uninstallHostSkill', 'host-agent should support host-level skill uninstall');
mustContain("command.type === 'host.skills.list'", 'host-agent should handle host.skills.list');
mustContain("command.type === 'host.skills.install'", 'host-agent should handle host.skills.install');
mustContain("command.type === 'host.skills.uninstall'", 'host-agent should handle host.skills.uninstall');
mustContain(
  'Legacy Skill install/uninstall commands are disabled for managed deployment Hosts',
  'Phase 3 Hosts must reject legacy mutation commands that were queued before capability registration'
);
mustContain("type: 'host.skills.result'", 'host-agent should emit host.skills.result');
mustContain('SKILL.md', 'host-agent should discover skills by SKILL.md');
mustContain('readonly', 'host-agent should mark/block readonly skills');
mustContain('..', 'host-agent source should explicitly guard traversal tokens');
mustContain('hostSkillInventoryV2: true', 'host-agent should advertise inventory v2');
mustContain('codexHome: CODEX_HOME', 'host-agent registration should report its effective Codex home');
mustContain("command.type === 'host.skills.inventory.refresh'", 'host-agent should handle forced inventory refresh');
mustContain("type: 'host.skills.inventory'", 'host-agent should publish versioned inventory');
mustContain('HostSkillInventoryService', 'host-agent should use the testable inventory service');
mustContain('HostSkillArtifactService', 'host-agent should use the inventory-bound artifact export service');
mustContain('hostSkillArtifactsV1: true', 'host-agent should advertise artifact export support');
mustContain('function handleHostSkillArtifactCommand', 'host-agent should isolate artifact export result handling');
mustContain("command.type === 'host.skills.artifact.export'", 'host-agent should handle adoption export commands');
mustContain("type: 'host.skills.artifact.result'", 'host-agent should publish adoption export results');
mustContain('HostSkillDeploymentService', 'host-agent should use the managed Skill deployment service');
mustContain('hostSkillDeploymentV1: true', 'host-agent should advertise desired-state deployment support');
mustContain('function handleHostSkillDeploymentCommand', 'host-agent should isolate deployment result handling');
mustContain("command.type === 'host.skills.deployment.apply'", 'host-agent should handle deployment commands');
mustContain("type: 'host.skills.deployment.result'", 'host-agent should publish per-Host deployment results');
mustContain('commandId: Number(command.id || 0)', 'deployment results must identify the command Relay should atomically acknowledge');
mustContain('let deploymentEvent;', 'deployment apply errors and result delivery errors must be handled separately');
mustContain('await postEvent(deploymentEvent);', 'deployment result delivery should be a single retryable step');
mustContain('will retry deployment result delivery', 'a failed result delivery must leave the deployment command unacknowledged');
mustContain("(res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300", 'Host HTTP delivery must reject redirects and every non-2xx response');

const deploymentHandlerStart = agent.indexOf('async function handleHostSkillDeploymentCommand(command)');
const deploymentHandlerEnd = agent.indexOf('\n}', deploymentHandlerStart);
const deploymentHandlerSource = agent.slice(deploymentHandlerStart, deploymentHandlerEnd);
const pendingResultIndex = deploymentHandlerSource.indexOf('hostSkillDeployment.getPendingResult');
const applyDeploymentIndex = deploymentHandlerSource.indexOf('hostSkillDeployment.applyDeployment');
const stageResultIndex = deploymentHandlerSource.indexOf('hostSkillDeployment.stagePendingResult');
const postResultIndex = deploymentHandlerSource.indexOf('await postEvent(deploymentEvent);');
const clearResultIndex = deploymentHandlerSource.indexOf('hostSkillDeployment.clearPendingResult');
assert(pendingResultIndex >= 0 && pendingResultIndex < applyDeploymentIndex,
  'deployment retries must reuse a durable pending result before applying again');
assert(stageResultIndex > applyDeploymentIndex && stageResultIndex < postResultIndex,
  'deployment results must be persisted before delivery');
assert(clearResultIndex > postResultIndex,
  'durable deployment results must only be cleared after confirmed delivery');

const mainStart = agent.indexOf('async function main()');
const mainEnd = agent.indexOf('\n}', mainStart);
const mainSource = agent.slice(mainStart, mainEnd);
const registerIndex = mainSource.indexOf("retryStartupStep('register host'");
const discoveryIndex = mainSource.indexOf('await runStartupDiscovery()');
const pollingIndex = mainSource.indexOf('pollCommandsLoop()');
assert(registerIndex >= 0 && discoveryIndex > registerIndex, 'startup discovery must run after Host registration');
assert(pollingIndex > discoveryIndex, 'startup discovery must restore workspace roots before deployment command polling');

console.log('host-agent skills manager contract ok');
