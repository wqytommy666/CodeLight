'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CLAUDE_EVENTS, CODEX_EVENTS, mergeHookGroups } = require('../shared/hook-config');

test('Codex config only receives hook event names supported by Codex', () => {
  const config = mergeHookGroups({}, 'codex', 'agent-light codex');
  assert.deepEqual(Object.keys(config.hooks), [...CODEX_EVENTS]);
  assert.equal(config.hooks.PostToolUseFailure, undefined);
  assert.equal(config.hooks.Notification, undefined);
});

test('Claude config includes explicit notification and failure hooks', () => {
  const config = mergeHookGroups({}, 'claude', 'agent-light claude');
  assert.deepEqual(Object.keys(config.hooks), [...CLAUDE_EVENTS]);
  assert.ok(config.hooks.PostToolUseFailure);
  assert.ok(config.hooks.Notification);
});

test('hook merge preserves unrelated settings and is idempotent', () => {
  const original = { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }] } };
  const once = mergeHookGroups(original, 'codex', 'agent-light codex');
  const twice = mergeHookGroups(once, 'codex', 'agent-light codex');
  assert.equal(twice.theme, 'dark');
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.Stop.filter((group) => group.hooks.some((hook) => hook.command === 'agent-light codex')).length, 1);
});
