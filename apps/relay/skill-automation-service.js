const crypto = require('crypto');

const REFRESH_INTERVALS = Object.freeze({
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
});

function text(value) {
  return String(value == null ? '' : value).trim();
}

function refreshIntervalMs(source = {}) {
  return REFRESH_INTERVALS[text(source.refreshPolicy).toLowerCase()] || null;
}

function sourceRefreshDue(source, nowMs = Date.now()) {
  if (!source || source.enabled === false || text(source.kind).toLowerCase() !== 'github') return false;
  const interval = refreshIntervalMs(source);
  if (!interval) return false;
  const last = Date.parse(source.lastRefreshAt || source.lastSuccessAt || source.createdAt || '');
  return !Number.isFinite(last) || nowMs - last >= interval;
}

function deterministicRequestId(sourceId, artifactId, group) {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify([sourceId, artifactId, group]), 'utf8')
    .digest('hex');
  return `skill-auto:${hash}`;
}

function planEnabledHostRollouts(input = {}) {
  const sourceId = text(input.sourceId);
  const skillId = text(input.skillId).toLowerCase();
  const artifactId = text(input.artifactId).toLowerCase();
  if (!sourceId || !skillId || !artifactId) return [];
  const groups = new Map();
  for (const desired of Array.isArray(input.desiredStates) ? input.desiredStates : []) {
    if (
      text(desired.skillId).toLowerCase() !== skillId
      || text(desired.desiredState).toLowerCase() !== 'enabled'
      || text(desired.artifactId).toLowerCase() === artifactId
    ) {
      continue;
    }
    const hostId = text(desired.hostId);
    const targetScope = text(desired.scope || 'user').toLowerCase();
    const scopeId = targetScope === 'project' ? text(desired.scopeId || desired.cwd) : 'user';
    const cwd = targetScope === 'project' ? text(desired.cwd || scopeId) : null;
    if (!hostId || !['user', 'project'].includes(targetScope) || (targetScope === 'project' && !cwd)) continue;
    const key = JSON.stringify([targetScope, scopeId, cwd]);
    if (!groups.has(key)) groups.set(key, { targetScope, scopeId, cwd, targetHostIds: new Set() });
    groups.get(key).targetHostIds.add(hostId);
  }
  return [...groups.values()].map((group) => {
    const targetHostIds = [...group.targetHostIds].sort();
    const identity = [group.targetScope, group.scopeId, group.cwd, targetHostIds];
    return {
      requestId: deterministicRequestId(sourceId, artifactId, identity),
      action: 'enable',
      skillId,
      artifactId,
      targetHostIds,
      targetScope: group.targetScope,
      scopeId: group.scopeId,
      cwd: group.cwd,
      confirmProjectWrite: group.targetScope === 'project',
      createdBy: 'skill-automation',
      automation: { sourceId, policy: 'enabled-hosts' },
    };
  }).sort((left, right) => left.requestId.localeCompare(right.requestId));
}

class SkillAutomationService {
  constructor(options = {}) {
    this.loadSources = options.loadSources || (() => []);
    this.scheduleRefresh = options.scheduleRefresh;
    this.loadDesiredStates = options.loadDesiredStates || (() => []);
    this.dispatchRollout = options.dispatchRollout;
    this.audit = options.audit || (() => {});
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimer || setInterval;
    this.clearTimer = options.clearTimer || clearInterval;
    this.tickIntervalMs = Math.max(1000, Number(options.tickIntervalMs || 5 * 60 * 1000));
    this.inFlight = new Set();
    this.timer = null;
    this.tickPromise = null;
  }

  start() {
    if (this.timer || typeof this.scheduleRefresh !== 'function') return false;
    this.timer = this.setTimer(() => void this.tick(), this.tickIntervalMs);
    this.timer?.unref?.();
    void this.tick();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    this.clearTimer(this.timer);
    this.timer = null;
    return true;
  }

  tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = Promise.resolve().then(async () => {
      const due = (await this.loadSources()).filter((source) => sourceRefreshDue(source, this.now()));
      for (const source of due) {
        const sourceId = text(source.sourceId);
        if (!sourceId || this.inFlight.has(sourceId)) continue;
        this.inFlight.add(sourceId);
        this.audit('skills.source.refresh_scheduled', { sourceId, refreshPolicy: source.refreshPolicy });
        try {
          await this.scheduleRefresh(source);
        } catch (error) {
          this.audit('skills.source.refresh_schedule_failed', { sourceId, error: error.message });
        } finally {
          this.inFlight.delete(sourceId);
        }
      }
      return due.length;
    }).finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  async rolloutAfterRefresh(input = {}) {
    if (text(input.source?.rolloutPolicy).toLowerCase() !== 'enabled-hosts') return [];
    const plans = planEnabledHostRollouts({
      sourceId: input.source.sourceId,
      skillId: input.skillId,
      artifactId: input.artifactId,
      desiredStates: await this.loadDesiredStates(),
    });
    const results = [];
    for (const plan of plans) {
      this.audit('skills.rollout.requested', plan, { subject: plan.skillId });
      try {
        const result = await this.dispatchRollout(plan);
        results.push(result);
        this.audit('skills.rollout.dispatched', {
          requestId: plan.requestId,
          skillId: plan.skillId,
          artifactId: plan.artifactId,
          targetHostIds: plan.targetHostIds,
          deploymentId: result?.deployment?.deploymentId || null,
        });
      } catch (error) {
        this.audit('skills.rollout.failed', {
          requestId: plan.requestId,
          skillId: plan.skillId,
          artifactId: plan.artifactId,
          targetHostIds: plan.targetHostIds,
          error: error.message,
        });
      }
    }
    return results;
  }
}

module.exports = {
  REFRESH_INTERVALS,
  SkillAutomationService,
  planEnabledHostRollouts,
  refreshIntervalMs,
  sourceRefreshDue,
};
