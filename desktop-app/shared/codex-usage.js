'use strict';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function windowLabel(minutes, prefix = '') {
  const duration = finiteNumber(minutes);
  let label = '额度';
  if (duration != null) {
    if (duration <= 360) label = `${Math.max(1, Math.round(duration / 60))} 小时`;
    else if (duration >= 6 * 24 * 60 && duration <= 8 * 24 * 60) label = '每周';
    else if (duration % (24 * 60) === 0) label = `${Math.round(duration / (24 * 60))} 天`;
    else label = `${Math.max(1, Math.round(duration / 60))} 小时`;
  }
  return prefix ? `${prefix} · ${label}` : label;
}

function normalizeWindow(window, id, prefix = '') {
  if (!window || typeof window !== 'object') return null;
  const used = finiteNumber(window.usedPercent ?? window.used_percent);
  if (used == null) return null;
  const minutes = finiteNumber(window.windowDurationMins)
    ?? (finiteNumber(window.limit_window_seconds) == null ? null : finiteNumber(window.limit_window_seconds) / 60);
  const reset = finiteNumber(window.resetsAt ?? window.reset_at);
  return {
    id,
    label: windowLabel(minutes, prefix),
    usedPercent: clampPercent(used),
    remainingPercent: clampPercent(100 - used),
    resetsAt: reset == null ? null : reset * (reset < 10_000_000_000 ? 1000 : 1),
    windowDurationMins: minutes,
  };
}

function normalizeCodexQuota(result, now = Date.now()) {
  const main = result?.rateLimits ?? result?.rate_limits ?? {};
  const lanes = [
    normalizeWindow(main.primary, 'codex-primary'),
    normalizeWindow(main.secondary, 'codex-secondary'),
  ].filter(Boolean);

  const byId = result?.rateLimitsByLimitId ?? result?.rate_limits_by_limit_id ?? {};
  for (const [id, limit] of Object.entries(byId)) {
    if (!limit || id === 'codex' || limit.limitId === 'codex') continue;
    const rawName = String(limit.limitName ?? limit.limit_name ?? id);
    const shortName = /spark/i.test(rawName) ? 'Spark' : rawName.replace(/^GPT[-\s]*/i, '').slice(0, 18);
    for (const [kind, window] of [['primary', limit.primary], ['secondary', limit.secondary]]) {
      const lane = normalizeWindow(window, `${id}-${kind}`, shortName);
      if (lane) lanes.push(lane);
    }
  }

  lanes.sort((a, b) => {
    const aExtra = a.id.startsWith('codex-') ? 0 : 1;
    const bExtra = b.id.startsWith('codex-') ? 0 : 1;
    return aExtra - bExtra || (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity);
  });

  const credits = main.credits ?? {};
  const resetCredits = result?.rateLimitResetCredits ?? result?.rate_limit_reset_credits ?? {};
  return {
    status: 'ready',
    plan: String(main.planType ?? main.plan_type ?? 'unknown').toUpperCase(),
    lanes: lanes.slice(0, 3),
    balance: finiteNumber(credits.balance),
    unlimited: credits.unlimited === true,
    resetCredits: Math.max(0, Math.round(finiteNumber(resetCredits.availableCount ?? resetCredits.available_count) ?? 0)),
    updatedAt: now,
    error: '',
  };
}

module.exports = { finiteNumber, clampPercent, windowLabel, normalizeWindow, normalizeCodexQuota };
