'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapHookEvent, StatusRuntime, definiteFailure, errorNotification } = require('../shared/state-machine');

const base = { session_id: 'test-session' };

test('maps the agreed Claude/Codex lifecycle states', () => {
  assert.equal(mapHookEvent('codex', { ...base, hook_event_name: 'Stop' }).state, 'green');
  assert.equal(mapHookEvent('claude', { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' }).state, 'yellow');
  assert.equal(mapHookEvent('codex', { ...base, hook_event_name: 'PreToolUse', tool_name: 'request_user_input' }).state, 'blue');
  assert.equal(mapHookEvent('claude', { ...base, hook_event_name: 'PostToolUseFailure' }).state, 'red');
});

test('does not treat ordinary text containing scary words as a definite failure', () => {
  assert.equal(definiteFailure({ output: 'the documentation mentions error handling' }), false);
  assert.equal(definiteFailure({ result: { exit_code: 1 } }), true);
  assert.equal(definiteFailure({ response: { status_code: 200 } }), false);
  assert.equal(definiteFailure({ response: { status_code: 503 } }), true);
  assert.equal(definiteFailure({ ok: false }), true);
});

test('recognizes network, authentication and rate-limit notifications', () => {
  assert.equal(errorNotification({ notification_type: 'rate_limit' }), true);
  assert.equal(errorNotification({ message: '网络连接失败，请稍后再试' }), true);
  assert.equal(errorNotification({ notification_type: 'idle_prompt' }), false);
});

test('priority is red > yellow > blue > green and clear reveals the next state', () => {
  let now = 1_000;
  const runtime = new StatusRuntime({ now: () => now, tickMs: 0 });
  runtime.set('done', 'green', 30);
  now += 1; runtime.set('question', 'blue', 30);
  now += 1; runtime.set('permission', 'yellow', 30);
  now += 1; runtime.set('failure', 'red', 30);
  assert.equal(runtime.displayed, 'red');
  runtime.clear('failure'); assert.equal(runtime.displayed, 'yellow');
  runtime.clear('permission'); assert.equal(runtime.displayed, 'blue');
  runtime.clear('question'); assert.equal(runtime.displayed, 'green');
  runtime.close();
});

test('green completion stays for one minute and then returns the lamp to off', () => {
  let now = 10_000;
  const runtime = new StatusRuntime({ now: () => now, tickMs: 0 });
  runtime.applyHook('codex', { ...base, hook_event_name: 'Stop' });
  assert.equal(runtime.displayed, 'green');
  now += 60_001;
  runtime.prune();
  assert.equal(runtime.displayed, 'off');
  runtime.close();
});

test('a fast next prompt and session end cannot erase completion green early', () => {
  let now = 20_000;
  const runtime = new StatusRuntime({ now: () => now, tickMs: 0 });
  runtime.applyHook('codex', { ...base, hook_event_name: 'Stop' });
  now += 1_000;
  runtime.applyHook('codex', { ...base, hook_event_name: 'UserPromptSubmit' });
  assert.equal(runtime.displayed, 'green');
  runtime.applyHook('codex', { ...base, hook_event_name: 'SessionEnd', reason: 'other' });
  assert.equal(runtime.displayed, 'green');
  now += 59_001;
  runtime.prune();
  assert.equal(runtime.displayed, 'off');
  runtime.close();
});

test('a newer project completion interrupts green with a fresh burst and timer', () => {
  let now = 100_000;
  const runtime = new StatusRuntime({ now: () => now, tickMs: 0 });
  const displays = [];
  runtime.on('display', (event) => displays.push(event));
  runtime.applyHook('claude', { session_id: 'project-a', hook_event_name: 'Stop' });
  now += 20_000;
  runtime.applyHook('codex', { session_id: 'project-b', hook_event_name: 'Stop' });
  assert.equal(runtime.displayed, 'green');
  assert.equal(displays.length, 2);
  assert.equal(displays.at(-1).force, true);
  now += 59_999;
  runtime.prune();
  assert.equal(runtime.displayed, 'green');
  now += 2;
  runtime.prune();
  assert.equal(runtime.displayed, 'off');
  runtime.close();
});

test('a newer lower-priority event does not interrupt an unresolved higher-priority state', () => {
  let now = 200_000;
  const runtime = new StatusRuntime({ now: () => now, tickMs: 0 });
  const displays = [];
  runtime.on('display', (event) => displays.push(event));
  runtime.applyHook('claude', { session_id: 'failed', hook_event_name: 'PostToolUseFailure' });
  now += 1_000;
  runtime.applyHook('codex', { session_id: 'finished', hook_event_name: 'Stop' });
  assert.equal(runtime.displayed, 'red');
  assert.equal(displays.length, 1);
  runtime.close();
});

test('SessionEnd without an explicit failure clears instead of reporting a fault', () => {
  const runtime = new StatusRuntime({ tickMs: 0 });
  const session = { session_id: 'short-helper-session' };
  runtime.applyHook('claude', { ...session, hook_event_name: 'UserPromptSubmit' });
  runtime.applyHook('claude', { ...session, hook_event_name: 'SessionEnd', reason: 'other' });
  assert.equal(runtime.displayed, 'off');
  runtime.close();
});

test('SessionEnd with an explicit failure still reports red', () => {
  const runtime = new StatusRuntime({ tickMs: 0 });
  runtime.applyHook('claude', { session_id: 'failed-session', hook_event_name: 'SessionEnd', reason: 'network_error' });
  assert.equal(runtime.displayed, 'red');
  runtime.close();
});

test('new activity clears handled yellow/red/blue attention states', () => {
  const runtime = new StatusRuntime({ tickMs: 0 });
  runtime.applyHook('claude', { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  runtime.applyHook('claude', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(runtime.displayed, 'off');
  runtime.applyHook('claude', { ...base, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' });
  assert.equal(runtime.displayed, 'blue');
  runtime.applyHook('claude', { ...base, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
  assert.equal(runtime.displayed, 'off');
  runtime.applyHook('claude', { ...base, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' });
  runtime.applyHook('claude', { ...base, hook_event_name: 'UserPromptSubmit' });
  assert.equal(runtime.displayed, 'off');
  runtime.close();
});
