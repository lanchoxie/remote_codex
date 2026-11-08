'use strict';

const DEFAULT_STAGE_LIMIT = 24;

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function createInputRequestTimer(options = {}) {
  const enabled = options.enabled !== false;
  const clock = typeof options.clock === 'function'
    ? options.clock
    : () => Number(process.hrtime.bigint()) / 1e6;
  const stageLimit = Math.max(1, Math.min(DEFAULT_STAGE_LIMIT, Number(options.stageLimit || DEFAULT_STAGE_LIMIT) || DEFAULT_STAGE_LIMIT));
  const startedAt = finiteNonNegative(clock());
  let previousAt = startedAt;
  const stages = [];

  function mark(name) {
    if (!enabled || stages.length >= stageLimit) return;
    const label = String(name || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
    if (!label) return;
    const current = Math.max(previousAt, finiteNonNegative(clock(), previousAt));
    stages.push({ name: label, durationMs: current - previousAt });
    previousAt = current;
  }

  function totalMs() {
    return Math.max(0, finiteNonNegative(clock(), previousAt) - startedAt);
  }

  function headers() {
    if (!enabled) return {};
    const total = totalMs();
    const serverTiming = stages
      .map((stage) => `${stage.name};dur=${stage.durationMs.toFixed(2)}`)
      .concat(`total;dur=${total.toFixed(2)}`)
      .join(', ');
    return {
      'Server-Timing': serverTiming,
      'X-Remote-Codex-Input-Total-Ms': total.toFixed(2),
      'Access-Control-Expose-Headers': 'Server-Timing, X-Remote-Codex-Input-Total-Ms',
    };
  }

  return Object.freeze({ mark, headers, totalMs });
}

module.exports = { createInputRequestTimer };
