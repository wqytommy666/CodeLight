'use strict';

const CLAUDE_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SessionEnd',
]);
const CODEX_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'Stop',
]);

function supportedEvents(source) {
  if (source === 'claude') return CLAUDE_EVENTS;
  if (source === 'codex') return CODEX_EVENTS;
  throw new Error(`Unsupported hook source: ${source}`);
}

function mergeHookGroups(input, source, command) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  data.hooks ||= {};
  for (const event of supportedEvents(source)) {
    data.hooks[event] ||= [];
    const already = data.hooks[event].some((group) => (group.hooks || []).some((hook) => hook.command === command));
    if (!already) data.hooks[event].push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 1 }] });
  }
  return data;
}

module.exports = { CLAUDE_EVENTS, CODEX_EVENTS, supportedEvents, mergeHookGroups };
