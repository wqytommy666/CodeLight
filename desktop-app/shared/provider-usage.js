'use strict';

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCodexBarProviderSnapshot(document, providerId) {
  const provider = String(providerId || '').toLowerCase();
  const entry = Array.isArray(document?.entries)
    ? document.entries.find((item) => String(item?.provider || '').toLowerCase() === provider)
    : null;
  if (!entry) return null;

  const windows = [entry.primary, entry.secondary, entry.tertiary].filter(Boolean);
  const rows = Array.isArray(entry.usageRows) ? entry.usageRows : [];
  const lanes = rows.map((row, index) => {
    const window = windows[index] || {};
    const remainingPercent = row.percentLeft === undefined
      ? Math.max(0, 100 - finiteNumber(window.usedPercent))
      : finiteNumber(row.percentLeft);
    return {
      id: String(row.id || `lane-${index + 1}`),
      label: String(row.title || `额度 ${index + 1}`),
      remainingPercent: Math.max(0, Math.min(100, Math.round(remainingPercent))),
      resetsAt: window.resetsAt ? Date.parse(window.resetsAt) : null,
    };
  });
  const token = entry.tokenUsage || {};
  const localizePeriod = (label, fallback) => {
    const value = String(label || fallback);
    if (/^today$/i.test(value)) return '今日';
    if (/^30d$/i.test(value)) return '30 天';
    return value;
  };
  const stats = [
    token.sessionTokens === undefined ? null : { label: localizePeriod(token.sessionLabel, '今日'), value: finiteNumber(token.sessionTokens), kind: 'tokens' },
    token.last30DaysTokens === undefined ? null : { label: localizePeriod(token.last30DaysLabel, '30 天'), value: finiteNumber(token.last30DaysTokens), kind: 'tokens' },
  ].filter(Boolean);
  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : (document.generatedAt ? Date.parse(document.generatedAt) : null);
  return {
    status: updatedAt && Date.now() - updatedAt > 30 * 60 * 1000 ? 'stale' : 'ready',
    plan: provider.toUpperCase(),
    lanes,
    stats,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    source: 'CodexBar 本地快照',
    resetCredits: 0,
    error: '',
  };
}

const CLAUDE_HISTORY_LANES = [
  ['fh', '5 小时额度'],
  ['sd', '每周额度'],
  ['oa', '每周 · Claude Code'],
  ['so', '每周 · Opus'],
  ['sn', '每周 · Sonnet'],
  ['cw', '每周 · Cowork'],
  ['om', '每周 · Claude Design'],
  ['op', 'Claude Design 赠送额度'],
];

function normalizeClaudePlanUsageHistory(document, now = Date.now()) {
  const samples = Array.isArray(document?.samples) ? document.samples : [];
  let latest = null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    const usage = sample?.u && typeof sample.u === 'object'
      ? sample.u
      : { fh: sample?.fh, sd: sample?.sd };
    if (CLAUDE_HISTORY_LANES.some(([id]) => Number.isFinite(Number(usage[id])))) {
      latest = { sample, usage };
      break;
    }
  }
  if (!latest) return null;

  const updatedAt = finiteNumber(latest.sample.t, 0);
  const lanes = CLAUDE_HISTORY_LANES.flatMap(([id, label]) => {
    if (!Number.isFinite(Number(latest.usage[id]))) return [];
    const usedPercent = Math.max(0, Math.min(100, Math.round(finiteNumber(latest.usage[id]))));
    return [{
      id,
      label,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: null,
      resetLabel: `已使用 ${usedPercent}%`,
    }];
  });

  return {
    status: updatedAt && now - updatedAt > 20 * 60 * 1000 ? 'stale' : 'ready',
    plan: 'CLAUDE CODE',
    lanes,
    stats: [],
    updatedAt: updatedAt || null,
    source: 'Claude 官方客户端额度',
    resetCredits: 0,
    error: '',
  };
}

function parsedTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function claudeScopeLabel(scope) {
  const raw = String(scope?.model?.display_name || scope?.surface?.display_name || '').trim();
  if (!raw) return '';
  return /^fable$/i.test(raw) ? 'Fable 5' : raw;
}

function normalizeClaudeUsageResponse(response, now = Date.now()) {
  const entries = Array.isArray(response?.limits) && response.limits.length
    ? response.limits
    : [
      response?.five_hour ? { kind: 'session', group: 'session', percent: response.five_hour.utilization, resets_at: response.five_hour.resets_at } : null,
      response?.seven_day ? { kind: 'weekly_all', group: 'weekly', percent: response.seven_day.utilization, resets_at: response.seven_day.resets_at } : null,
      response?.seven_day_opus ? { kind: 'weekly_scoped', group: 'weekly', percent: response.seven_day_opus.utilization, resets_at: response.seven_day_opus.resets_at, scope: { model: { display_name: 'Opus' } } } : null,
      response?.seven_day_sonnet ? { kind: 'weekly_scoped', group: 'weekly', percent: response.seven_day_sonnet.utilization, resets_at: response.seven_day_sonnet.resets_at, scope: { model: { display_name: 'Sonnet' } } } : null,
    ].filter(Boolean);

  const lanes = entries.flatMap((entry, index) => {
    if (!Number.isFinite(Number(entry?.percent))) return [];
    const usedPercent = Math.max(0, Math.min(100, Math.round(finiteNumber(entry.percent))));
    const scope = claudeScopeLabel(entry.scope);
    const label = entry.kind === 'session' ? '5 小时额度'
      : entry.kind === 'weekly_all' ? '每周额度'
        : scope ? `每周 · ${scope}` : entry.group === 'weekly' ? '每周专项额度' : 'Claude 额度';
    return [{
      id: `${entry.kind || entry.group || 'limit'}-${scope || index}`,
      label,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: parsedTimestamp(entry.resets_at),
      severity: String(entry.severity || ''),
      active: Boolean(entry.is_active),
    }];
  });
  if (!lanes.length) return null;

  return {
    status: 'ready',
    plan: 'CLAUDE CODE',
    lanes,
    stats: [],
    updatedAt: now,
    source: 'Claude 实时额度',
    resetCredits: 0,
    error: '',
  };
}

module.exports = { normalizeCodexBarProviderSnapshot, normalizeClaudePlanUsageHistory, normalizeClaudeUsageResponse };
