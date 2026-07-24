'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, devicesForSource, effectiveDurationSeconds } = require('../shared/settings');

test('default settings expose an extensible provider registry and 60 second duration', () => {
  const settings = normalizeSettings({});
  assert.equal(settings.productName, 'CodeLight');
  assert.equal(settings.statusDurationSeconds, 60);
  assert.deepEqual(settings.providers.filter((provider) => provider.pinned).map((provider) => provider.id), ['claude', 'codex']);
  for (const id of ['claude', 'codex', 'opencode', 'mimo', 'zcode', 'hermes', 'kilo', 'gemini', 'amp', 'cursor', 'cline', 'roo', 'aider', 'goose', 'continue', 'qwen', 'trae', 'windsurf']) {
    assert.ok(settings.providers.some((provider) => provider.id === id), `missing ${id}`);
  }
  for (const id of ['claude', 'codex', 'opencode', 'mimo', 'zcode', 'hermes', 'qwen', 'gemini', 'kilo', 'copilot', 'cursor', 'windsurf', 'trae', 'cline', 'roo', 'kiro', 'aider', 'openhands', 'goose', 'amp', 'continue', 'pi', 'crush']) {
    assert.ok(settings.providers.find((provider) => provider.id === id)?.asset, `missing logo asset for ${id}`);
  }
});

test('custom providers survive normalization without changing core code', () => {
  const settings = normalizeSettings({ providers: [{ id: 'my-agent', name: 'My Agent', appPath: '/Applications/My Agent.app', accent: '#123456', pinned: true }] });
  assert.deepEqual(settings.providers.map((provider) => provider.id), ['my-agent']);
  assert.equal(settings.providers[0].appPath, '/Applications/My Agent.app');
  assert.equal(settings.providers[0].pinned, true);
});

test('device routes are independent per provider', () => {
  const settings = normalizeSettings({
    providers: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
    devices: [
      { id: 'lamp-a', sources: ['claude'] },
      { id: 'lamp-b', sources: ['codex'] },
    ],
  });
  assert.deepEqual(devicesForSource(settings, 'claude').map((device) => device.id), ['lamp-a']);
  assert.deepEqual(devicesForSource(settings, 'codex').map((device) => device.id), ['lamp-b']);
});

test('identical Bluetooth product names receive stable visible aliases', () => {
  const settings = normalizeSettings({ devices: [
    { id: '960ACC6B-B7EB-F4A1-94E1-940DC59137C1', name: 'JTX-RGB' },
    { id: 'FF250313-33FD-4A10-A100-111111111111', name: 'JTX-RGB' },
  ] });
  assert.equal(settings.devices[0].name, '状态灯 A · 960A');
  assert.equal(settings.devices[1].name, '状态灯 B · FF25');
});

test('custom lamp aliases are preserved', () => {
  const settings = normalizeSettings({ devices: [{ id: 'lamp-a', name: '桌面 Claude 灯' }] });
  assert.equal(settings.devices[0].name, '桌面 Claude 灯');
});

test('always-on duration maps to a long-lived runtime TTL', () => {
  assert.equal(effectiveDurationSeconds(normalizeSettings({ statusDurationSeconds: 0 })), 315_360_000);
});

test('disabled provider does not route events to a lamp', () => {
  const settings = normalizeSettings({
    providers: [{ id: 'codex', name: 'Codex', enabled: false }],
    devices: [{ id: 'lamp-a', sources: ['codex'] }],
  });
  assert.deepEqual(devicesForSource(settings, 'codex'), []);
});
