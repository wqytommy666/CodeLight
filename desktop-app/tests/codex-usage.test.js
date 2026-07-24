'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCodexQuota, windowLabel } = require('../shared/codex-usage');

test('labels common Codex quota windows clearly', () => {
  assert.equal(windowLabel(300), '5 小时');
  assert.equal(windowLabel(10080), '每周');
  assert.equal(windowLabel(10080, 'Spark'), 'Spark · 每周');
});

test('normalizes app-server quota without exposing account data', () => {
  const quota = normalizeCodexQuota({
    rateLimits: {
      planType: 'pro',
      primary: { usedPercent: 66, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
      credits: { balance: '0', unlimited: false },
    },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex' },
      codex_spark: {
        limitId: 'codex_spark', limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
      },
    },
    rateLimitResetCredits: { availableCount: 3 },
    account: { email: 'must-not-leak@example.com' },
  }, 1234);

  assert.equal(quota.plan, 'PRO');
  assert.deepEqual(quota.lanes.map((lane) => [lane.label, lane.remainingPercent]), [
    ['每周', 34], ['Spark · 每周', 88],
  ]);
  assert.equal(quota.resetCredits, 3);
  assert.equal(JSON.stringify(quota).includes('must-not-leak'), false);
});
