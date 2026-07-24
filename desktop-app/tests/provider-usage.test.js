'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCodexBarProviderSnapshot, normalizeClaudePlanUsageHistory, normalizeClaudeUsageResponse } = require('../shared/provider-usage');

test('normalizes Claude quota and local token summaries from a CodexBar snapshot', () => {
  const value = normalizeCodexBarProviderSnapshot({
    generatedAt: new Date().toISOString(),
    entries: [{
      provider: 'claude', updatedAt: new Date().toISOString(),
      primary: { usedPercent: 20, resetsAt: '2030-01-01T00:00:00Z' },
      usageRows: [{ id: 'session', title: '会话', percentLeft: 80 }],
      tokenUsage: { sessionLabel: '今日', sessionTokens: 1200, last30DaysLabel: '30 天', last30DaysTokens: 44000 },
    }],
  }, 'claude');
  assert.equal(value.plan, 'CLAUDE');
  assert.deepEqual(value.lanes.map((lane) => [lane.label, lane.remainingPercent]), [['会话', 80]]);
  assert.deepEqual(value.stats.map((stat) => stat.value), [1200, 44000]);
});

test('returns null for a provider missing from the shared snapshot', () => {
  assert.equal(normalizeCodexBarProviderSnapshot({ entries: [] }, 'claude'), null);
});

test('normalizes the official Claude plan history into real remaining quota lanes', () => {
  const now = Date.parse('2030-01-01T12:00:00Z');
  const value = normalizeClaudePlanUsageHistory({
    version: 2,
    samples: [
      { t: now - 600_000, org: 'private-org-id', u: { fh: 33, sd: 55 } },
    ],
  }, now);
  assert.equal(value.plan, 'CLAUDE CODE');
  assert.equal(value.status, 'ready');
  assert.equal(value.source, 'Claude 官方客户端额度');
  assert.deepEqual(value.lanes.map((lane) => [lane.label, lane.usedPercent, lane.remainingPercent, lane.resetLabel]), [
    ['5 小时额度', 33, 67, '已使用 33%'],
    ['每周额度', 55, 45, '已使用 55%'],
  ]);
  assert.equal(JSON.stringify(value).includes('private-org-id'), false);
});

test('supports legacy Claude history and marks an old sample stale', () => {
  const now = Date.parse('2030-01-01T12:00:00Z');
  const value = normalizeClaudePlanUsageHistory({
    version: 1,
    samples: [{ t: now - 30 * 60_000, fh: 12, sd: 40 }],
  }, now);
  assert.equal(value.status, 'stale');
  assert.deepEqual(value.lanes.map((lane) => lane.remainingPercent), [88, 60]);
});

test('returns null when Claude history has no quota samples', () => {
  assert.equal(normalizeClaudePlanUsageHistory({ version: 2, samples: [] }), null);
});

test('normalizes live Claude limits including the Fable 5 scoped quota', () => {
  const now = Date.parse('2030-01-01T12:00:00Z');
  const value = normalizeClaudeUsageResponse({
    limits: [
      { kind: 'session', group: 'session', percent: 49, resets_at: '2030-01-01T13:00:00Z' },
      { kind: 'weekly_all', group: 'weekly', percent: 58, resets_at: '2030-01-05T12:00:00Z' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 99, severity: 'critical', is_active: true, resets_at: '2030-01-05T12:00:00Z', scope: { model: { display_name: 'Fable' } } },
    ],
  }, now);
  assert.deepEqual(value.lanes.map((lane) => [lane.label, lane.remainingPercent]), [
    ['5 小时额度', 51],
    ['每周额度', 42],
    ['每周 · Fable 5', 1],
  ]);
  assert.equal(value.lanes[2].severity, 'critical');
  assert.equal(value.source, 'Claude 实时额度');
});
