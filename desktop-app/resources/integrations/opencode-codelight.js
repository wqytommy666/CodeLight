import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SOURCE = '__CODELIGHT_SOURCE__';

function sessionFrom(value = {}) {
  return value.sessionID || value.session_id || value.properties?.sessionID
    || value.properties?.session_id || value.id || `pid-${process.pid}`;
}

function dispatch(payload) {
  payload.session_id ||= sessionFrom(payload);
  if (process.platform === 'win32') {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    const socket = net.createConnection({ host: '127.0.0.1', port: 48733 });
    socket.setTimeout(250);
    socket.once('connect', () => socket.end(`hook-json ${SOURCE} ${encoded}\n`));
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => {});
    return;
  }
  const hook = path.join(os.homedir(), '.agent-status-light', 'bin', 'agent-light-hook');
  const child = spawn(hook, ['--source', SOURCE], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  child.unref();
  child.stdin.end(JSON.stringify(payload));
}

function fromEvent(event = {}) {
  const type = String(event.type || '');
  const session_id = sessionFrom(event);
  if (type === 'session.idle') dispatch({ hook_event_name: 'Stop', session_id });
  else if (type === 'session.error') dispatch({ hook_event_name: 'PostToolUseFailure', session_id, outcome: 'error' });
  else if (type === 'permission.asked') dispatch({ hook_event_name: 'PermissionRequest', session_id, tool_name: event.properties?.permission || 'permission' });
  else if (type === 'permission.replied') dispatch({ hook_event_name: 'UserPromptSubmit', session_id });
  else if (type === 'session.created' || (type === 'session.status' && event.properties?.status === 'busy')) dispatch({ hook_event_name: 'UserPromptSubmit', session_id });
}

export const CodeLightPlugin = async () => ({
  event: async ({ event }) => fromEvent(event),
  'chat.message': async (input) => dispatch({ hook_event_name: 'UserPromptSubmit', session_id: input.sessionID }),
  'permission.ask': async (input) => dispatch({ hook_event_name: 'PermissionRequest', session_id: sessionFrom(input), tool_name: input.permission || 'permission' }),
  'tool.execute.before': async (input) => dispatch({ hook_event_name: 'PreToolUse', session_id: input.sessionID, tool_name: input.tool }),
  'tool.execute.after': async (input) => dispatch({ hook_event_name: 'PostToolUse', session_id: input.sessionID, tool_name: input.tool }),
});
