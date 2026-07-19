const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const OBJECT_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizePortableSkillId(value, options = {}) {
  const maxLength = Math.max(1, Number(options.maxLength || 240));
  const skillId = String(value == null ? '' : value).trim();
  if (!skillId) {
    throw new Error('skillId is required');
  }
  if (skillId.length > maxLength) {
    throw new Error(`skillId exceeds ${maxLength} characters`);
  }
  const lower = skillId.toLowerCase();
  if (
    !/^[A-Za-z0-9._-]+$/.test(skillId)
    || skillId === '.'
    || skillId === '..'
    || skillId.endsWith('.')
    || lower === '.system'
    || lower.startsWith('.remote-codex-')
    || OBJECT_PROTOTYPE_KEYS.has(lower)
    || WINDOWS_DEVICE_NAME.test(skillId)
  ) {
    throw new Error('skillId must be a safe portable directory name and not a reserved owner path');
  }
  return lower;
}

module.exports = {
  normalizePortableSkillId,
};
