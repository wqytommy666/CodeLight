'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const PRIORITY = Object.freeze({ off: 0, green: 1, blue: 2, yellow: 3, red: 4 });
const VALID_STATES = new Set(Object.keys(PRIORITY));

function firstString(payload, ...keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function sessionKey(source, payload) {
  const identity = firstString(payload, 'session_id', 'thread_id', 'conversation_id', 'transcript_path', 'cwd') || `pid-${process.ppid}`;
  const digest = crypto.createHash('sha256').update(`${source}:${identity}`).digest('hex').slice(0, 24);
  return `${source}-${digest}`;
}

function normalizedTool(payload) {
  let name = firstString(payload, 'tool_name', 'tool', 'name');
  if (!name && payload?.tool && typeof payload.tool === 'object') {
    name = firstString(payload.tool, 'name', 'tool_name');
  }
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isQuestionTool(tool) {
  return new Set([
    'askuserquestion', 'askfollowupquestion', 'requestuserinput',
    'functionsrequestuserinput', 'mcprequestuserinput',
  ]).has(tool) || tool.endsWith('requestuserinput');
}

function definiteFailure(value, depth = 0) {
  if (depth > 5 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => definiteFailure(item, depth + 1));
  if (typeof value !== 'object') return false;
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey.toLowerCase().replaceAll('-', '_');
    if (['is_error', 'iserror', 'failed', 'failure'].includes(key) && item === true) return true;
    if (['success', 'ok'].includes(key) && item === false) return true;
    if (['exit_code', 'exitcode'].includes(key) && Number.isInteger(item) && item !== 0) return true;
    if (key === 'status_code' && Number.isInteger(item) && item >= 400) return true;
    if (['status', 'outcome'].includes(key) && typeof item === 'string' && ['error', 'failed', 'failure', 'timed_out', 'timeout'].includes(item.toLowerCase())) return true;
    if (definiteFailure(item, depth + 1)) return true;
  }
  return false;
}

function diagnosticText(payload) {
  const keys = new Set([
    'error', 'message', 'formatted', 'reason', 'detail', 'title',
    'notification_type', 'type', 'outcome', 'status', 'code', 'stderr',
    'exception', 'cause',
  ]);
  const values = [];
  function collect(value, includeAll = false, depth = 0) {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      if (includeAll) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      if (includeAll) value.forEach((item) => collect(item, true, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const [rawKey, item] of Object.entries(value)) {
        const selected = includeAll || keys.has(rawKey.toLowerCase().replaceAll('-', '_'));
        if (selected) collect(item, true, depth + 1);
      }
    }
  }
  collect(payload);
  return values.join(' ').toLowerCase();
}

function networkIssue(payload) {
  const text = diagnosticText(payload);
  return [
    'network', 'connection', 'disconnected', 'stream disconnected',
    'error sending request', 'connect to api', 'socket', 'econn', 'dns',
    'tls', 'ssl', 'timed out', 'timeout', 'offline', 'unreachable',
    '网络', '连接', '重连', '超时', '断网',
  ].some((marker) => text.includes(marker));
}

function errorNotification(payload) {
  const type = firstString(payload, 'notification_type', 'type').toLowerCase();
  if (['error', 'failure', 'auth_error', 'network_error', 'rate_limit'].includes(type)) return true;
  const message = diagnosticText(payload);
  return [
    'rate limit', 'authentication failed', 'invalid api key', 'unauthorized',
    'network error', 'connection failed', 'connection lost',
    '额度不足', '认证失败', '鉴权失败', '网络错误', '网络连接失败', '连接中断',
  ].some((marker) => message.includes(marker));
}

function mapHookEvent(source, payload, { durationSeconds = 60 } = {}) {
  const ttl = durationSeconds === 0 ? 315_360_000 : Math.max(10, Math.min(300, Number(durationSeconds) || 60));
  const event = firstString(payload, 'hook_event_name', 'event');
  const key = sessionKey(source, payload);
  const tool = normalizedTool(payload);
  const result = { event, key, source, tool, action: 'ignore' };

  if (['SessionStart', 'UserPromptSubmit'].includes(event)) return { ...result, action: 'activity' };
  if (event === 'SessionEnd') {
    if (networkIssue(payload)) return { ...result, action: 'set', state: 'yellow', ttl, force: true, detail: '网络连接异常，请检查或切换网络' };
    const reason = firstString(payload, 'reason', 'outcome').toLowerCase();
    const failed = definiteFailure(payload) || [
      'error', 'failed', 'failure', 'timeout', 'timed_out', 'network',
      'connection', 'rate_limit', 'rate limit', 'auth', 'overloaded',
    ].some((marker) => reason.includes(marker));
    return { ...result, action: 'session-end', failed, ttl, force: true };
  }
  if (event === 'PermissionRequest') return { ...result, action: 'set', state: 'blue', ttl, force: true };
  if (event === 'PreToolUse') {
    return isQuestionTool(tool)
      ? { ...result, action: 'set', state: 'blue', ttl, force: true }
      : { ...result, action: 'activity' };
  }
  if (event === 'PostToolUseFailure') {
    return networkIssue(payload)
      ? { ...result, action: 'set', state: 'yellow', ttl, force: true, detail: '网络重试，请检查或切换网络' }
      : { ...result, action: 'activity' };
  }
  if (event === 'StopFailure') return { ...result, action: 'set', state: 'red', ttl, force: true };
  if (event === 'PostToolUse') {
    const failed = definiteFailure(payload.tool_response) || definiteFailure(payload.tool_result);
    if (failed && networkIssue(payload)) return { ...result, action: 'set', state: 'yellow', ttl, force: true, detail: '网络重试，请检查或切换网络' };
    return { ...result, action: 'activity' };
  }
  if (event === 'Notification') {
    const type = firstString(payload, 'notification_type', 'type').toLowerCase();
    if (networkIssue(payload)) return { ...result, action: 'set', state: 'yellow', ttl, force: true, detail: '网络重试，请检查或切换网络' };
    if (errorNotification(payload)) return { ...result, action: 'set', state: 'red', ttl, force: true };
    if (['permission_prompt', 'permission'].includes(type)) return { ...result, action: 'set', state: 'blue', ttl, force: true };
    if (['idle_prompt', 'question', 'input_required'].includes(type)) return { ...result, action: 'set', state: 'blue', ttl, force: true };
  }
  if (event === 'Stop') {
    if (networkIssue(payload)) return { ...result, action: 'set', state: 'yellow', ttl, force: true, detail: '网络连接异常，请检查或切换网络' };
    const reason = firstString(payload, 'reason', 'stop_reason', 'outcome').toLowerCase();
    const failed = definiteFailure(payload) || [
      'error', 'failed', 'failure', 'rate_limit', 'rate limit', 'auth', 'overloaded',
    ].some((marker) => reason.includes(marker));
    return failed
      ? { ...result, action: 'set', state: 'red', ttl, force: true }
      : { ...result, action: 'set', state: 'green', ttl, force: true };
  }
  return result;
}

class StatusRuntime extends EventEmitter {
  constructor({ now = () => Date.now(), tickMs = 250 } = {}) {
    super();
    this.now = now;
    this.entries = new Map();
    this.displayed = 'off';
    this.timer = tickMs > 0 ? setInterval(() => this.prune(), tickMs) : null;
    this.timer?.unref?.();
  }

  set(key, state, ttlSeconds, force = false) {
    if (!VALID_STATES.has(state) || state === 'off') throw new Error(`Invalid state: ${state}`);
    const existing = this.entries.get(key);
    const now = this.now();
    this.entries.set(key, { state, updatedAt: now, expiresAt: now + Math.max(1, ttlSeconds) * 1000 });
    const incomingWins = this.effectiveEntry().key === key;
    this.refresh(incomingWins && (force || existing?.state !== state), { reason: 'set', key });
  }

  clear(key) {
    this.entries.delete(key);
    this.refresh(false, { reason: 'clear', key });
  }

  activity(key) {
    const current = this.entries.get(key)?.state;
    if (current === 'blue' || current === 'yellow' || current === 'red') this.clear(key);
  }

  clearAll() {
    this.entries.clear();
    this.refresh(true, { reason: 'clear-all' });
  }

  applyMapped(mapped) {
    if (mapped.action === 'set') this.set(mapped.key, mapped.state, mapped.ttl, mapped.force);
    else if (mapped.action === 'clear') this.clear(mapped.key);
    else if (mapped.action === 'activity') this.activity(mapped.key);
    else if (mapped.action === 'session-end') {
      const current = this.entries.get(mapped.key)?.state;
      if (current === 'green') {
        // Preserve the self-expiring completion acknowledgement.
      } else if (mapped.failed) this.set(mapped.key, 'red', mapped.ttl, mapped.force);
      else this.clear(mapped.key);
    }
    return this.snapshot();
  }

  applyHook(source, payload) {
    const mapped = mapHookEvent(source, payload);
    this.applyMapped(mapped);
    this.emit('hook', mapped);
    return mapped;
  }

  prune() {
    const now = this.now();
    let changed = false;
    for (const [key, value] of this.entries) {
      if (value.expiresAt <= now) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.refresh(false, { reason: 'expiry' });
  }

  effectiveEntry() {
    let winner = { key: '', state: 'off', updatedAt: 0 };
    for (const [key, entry] of this.entries) {
      if (PRIORITY[entry.state] > PRIORITY[winner.state] || (PRIORITY[entry.state] === PRIORITY[winner.state] && entry.updatedAt > winner.updatedAt)) {
        winner = { key, ...entry };
      }
    }
    return winner;
  }

  effective() {
    return this.effectiveEntry().state;
  }

  refresh(force = false, metadata = {}) {
    const next = this.effective();
    if (!force && next === this.displayed) return;
    const previous = this.displayed;
    this.displayed = next;
    this.emit('display', { state: next, previous, force, ...metadata, snapshot: this.snapshot() });
  }

  snapshot() {
    return {
      displayed: this.displayed,
      active: [...this.entries.entries()].map(([key, value]) => ({ key, state: value.state, expiresAt: value.expiresAt })),
    };
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = {
  PRIORITY, VALID_STATES, sessionKey, normalizedTool, isQuestionTool,
  definiteFailure, diagnosticText, networkIssue, errorNotification, mapHookEvent, StatusRuntime,
};
