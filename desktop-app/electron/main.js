'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, session, shell, Notification, dialog, net: electronNet } = require('electron');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { StatusRuntime, mapHookEvent } = require('../shared/state-machine');
const { mergeHookGroups } = require('../shared/hook-config');
const { normalizeCodexQuota } = require('../shared/codex-usage');
const { normalizeCodexBarProviderSnapshot, normalizeClaudePlanUsageHistory, normalizeClaudeUsageResponse } = require('../shared/provider-usage');
const { PROVIDERS, providerById, normalizeProviderId } = require('../shared/providers');
const { normalizeSettings, normalizeDevice, devicesForSource, effectiveDurationSeconds } = require('../shared/settings');

const PORT = 48733;
const LABEL = 'com.local.agent-status-light';
const WATCH_LABEL = 'com.local.agent-status-light-watch';
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const startHidden = process.argv.includes('--hidden');

let mainWindow = null;
let tray = null;
let hookServer = null;
let quitting = false;
let bleStatus = { state: isWindows ? 'disconnected' : 'external', name: 'JTX-RGB', detail: '' };
let chargerSilence = true;
const eventLog = [];
let codexQuota = { status: 'loading', plan: '', lanes: [], balance: null, unlimited: false, resetCredits: 0, updatedAt: null, error: '' };
let codexQuotaRequest = null;
let claudeUsage = { status: 'loading', plan: 'CLAUDE', lanes: [], stats: [], updatedAt: null, source: '', error: '' };
let claudeUsageRequest = null;
const CODEX_QUOTA_TTL = 5 * 60 * 1000;
const HOOK_EVENT_LOG = path.join(os.homedir(), '.agent-status-light', 'events.jsonl');
const SETTINGS_PATH = path.join(os.homedir(), '.agent-status-light', 'config.json');
const windowsRuntimes = new Map();
const macDaemonProcesses = new Map();
let macDaemonGeneration = 0;
let notificationOffset = 0;
const notificationDedupe = new Map();
let connectionGuardInitialized = false;
let connectionWasReady = false;
let lastConnectionAlertAt = 0;
const windowsBleStatuses = new Map();
const deviceConnectionStates = new Map();

function readClaudeUsageSnapshot() {
  const claudeHistoryCandidates = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'plan-usage-history.json'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'plan-usage-history.json') : '',
  ].filter(Boolean);
  for (const candidate of claudeHistoryCandidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const normalized = normalizeClaudePlanUsageHistory(parsed);
      if (normalized) return normalized;
    } catch (_) {}
  }
  const candidates = [
    path.join(os.homedir(), 'Library', 'Group Containers', 'Y5PE65HELJ.com.steipete.codexbar', 'widget-snapshot.json'),
    path.join(os.homedir(), '.codexbar', 'widget-snapshot.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const normalized = normalizeCodexBarProviderSnapshot(parsed, 'claude');
      if (normalized) return normalized;
    } catch (_) {}
  }
  return {
    status: 'unavailable', plan: 'CLAUDE', lanes: [], stats: [], updatedAt: null,
    source: 'Claude Code', error: '未发现可读取的 Claude 额度源；任务状态与实体灯仍正常工作',
  };
}

function decryptClaudeCookie(host, encryptedHex, password) {
  const encrypted = Buffer.from(String(encryptedHex || ''), 'hex');
  if (encrypted.subarray(0, 3).toString() !== 'v10') return '';
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  const hostDigest = crypto.createHash('sha256').update(host).digest();
  if (plain.length >= hostDigest.length && plain.subarray(0, hostDigest.length).equals(hostDigest)) {
    plain = plain.subarray(hostDigest.length);
  }
  return plain.toString('utf8');
}

function readClaudeWebSession() {
  if (!isMac) return null;
  const support = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  const history = JSON.parse(fs.readFileSync(path.join(support, 'plan-usage-history.json'), 'utf8'));
  const org = [...(history.samples || [])].reverse().find((sample) => sample?.org)?.org;
  if (!org) throw new Error('Claude 本地记录中没有组织信息');

  const cookieResult = spawnSync('/usr/bin/sqlite3', [
    '-json', path.join(support, 'Cookies'),
    "select host_key,name,value,hex(encrypted_value) encrypted_value from cookies where host_key in ('.claude.ai','claude.ai')",
  ], { encoding: 'utf8', timeout: 3000, maxBuffer: 2_000_000 });
  if (cookieResult.status !== 0) throw new Error('无法读取 Claude 本地会话');
  const keyResult = spawnSync('/usr/bin/security', [
    'find-generic-password', '-s', 'Claude Safe Storage', '-a', 'Claude Key', '-w',
  ], { encoding: 'utf8', timeout: 3000, maxBuffer: 64_000 });
  if (keyResult.status !== 0) throw new Error('无法读取 Claude 本地加密密钥');
  const password = String(keyResult.stdout || '').trim();
  const rows = JSON.parse(cookieResult.stdout || '[]');
  const cookies = rows.flatMap((row) => {
    let value = String(row.value || '');
    if (!value && row.encrypted_value) {
      try { value = decryptClaudeCookie(row.host_key, row.encrypted_value, password); } catch (_) {}
    }
    return value ? [`${row.name}=${value}`] : [];
  });
  if (!cookies.some((item) => item.startsWith('sessionKey='))) throw new Error('Claude 登录会话已失效');
  return { org, cookie: cookies.join('; ') };
}

async function refreshClaudeUsage() {
  if (claudeUsageRequest) return claudeUsageRequest;
  const request = (async () => {
    const fallback = readClaudeUsageSnapshot();
    try {
      const context = readClaudeWebSession();
      if (!context) return fallback;
      const response = await electronNet.fetch(
        `https://claude.ai/api/organizations/${encodeURIComponent(context.org)}/usage?skip_spend=1`,
        {
          headers: { Accept: 'application/json', Cookie: context.cookie },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`Claude 额度接口返回 ${response.status}`);
      const normalized = normalizeClaudeUsageResponse(await response.json());
      if (!normalized) throw new Error('Claude 额度响应中没有可显示的项目');
      claudeUsage = normalized;
      return normalized;
    } catch (_) {
      const cachedLive = claudeUsage?.source?.startsWith('Claude 实时额度') && claudeUsage?.lanes?.length;
      claudeUsage = cachedLive
        ? { ...claudeUsage, status: 'stale', source: 'Claude 实时额度（缓存）' }
        : fallback;
      return claudeUsage;
    }
  })();
  claudeUsageRequest = request;
  try {
    return await request;
  } finally {
    if (claudeUsageRequest === request) claudeUsageRequest = null;
    publishSnapshot();
  }
}

function currentProvider(value) {
  return providerById(value, settings?.providers || PROVIDERS);
}

function providerIconUrl(provider) {
  const icon = String(provider.icon || '');
  if (!icon || /^(data:|https?:)/i.test(icon)) return icon;
  try {
    const stat = fs.statSync(icon);
    if (!stat.isFile() || stat.size > 2_000_000) return '';
    const extension = path.extname(icon).toLowerCase();
    const mime = extension === '.svg' ? 'image/svg+xml'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : extension === '.webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(icon).toString('base64')}`;
  } catch (_) { return ''; }
}

function presentedProviders() {
  return settings.providers.map((provider) => ({
    ...provider,
    iconUrl: providerIconUrl(provider),
    bridgeCommand: providerBridgeCommand(provider.id),
  }));
}

function legacyDeviceId() {
  try { return fs.readFileSync(path.join(os.homedir(), '.agent-status-light', 'device.id'), 'utf8').trim(); } catch (_) {}
  try { return fs.readFileSync(path.join(__dirname, '..', '..', 'device.id'), 'utf8').trim(); } catch (_) {}
  return '';
}

function loadSettings() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (_) {}
  const value = normalizeSettings(input, isMac ? legacyDeviceId() : '');
  value.devices.forEach((device, index) => { device.port = PORT + index; });
  return value;
}

let settings = loadSettings();

function saveSettings(next = settings) {
  settings = normalizeSettings(next, isMac ? legacyDeviceId() : '');
  settings.devices.forEach((device, index) => { device.port = PORT + index; });
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const temp = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temp, SETTINGS_PATH);
  syncWindowsRuntimes();
  publishSnapshot();
  return settings;
}

function syncWindowsRuntimes() {
  if (!isWindows) return;
  const wanted = new Set(settings.devices.filter((device) => device.enabled).map((device) => device.id));
  for (const [id, runtime] of windowsRuntimes) {
    if (!wanted.has(id)) { runtime.close(); windowsRuntimes.delete(id); }
  }
  for (const device of settings.devices.filter((item) => item.enabled)) {
    if (windowsRuntimes.has(device.id)) continue;
    const runtime = new StatusRuntime();
    runtime.on('display', (event) => {
      mainWindow?.webContents.send('device:display', { ...event, deviceId: device.id });
      logEvent('light', `${device.name} · ${event.state}`, event.reason || 'state-change');
    });
    windowsRuntimes.set(device.id, runtime);
  }
}

syncWindowsRuntimes();

function logEvent(kind, message, detail = '') {
  eventLog.unshift({ id: `${Date.now()}-${Math.random()}`, at: new Date().toISOString(), kind, message, detail });
  if (eventLog.length > 200) eventLog.length = 200;
  publishSnapshot();
}

function readHookEvents(limit = 200) {
  try {
    const descriptor = fs.openSync(HOOK_EVENT_LOG, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      const length = Math.min(size, 256_000);
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
      const records = buffer.toString('utf8').split(/\r?\n/).slice(size > length ? 1 : 0);
      const meaningful = new Set(['green', 'yellow', 'blue', 'red', 'red-deferred']);
      const seen = new Set();
      return records.reverse().flatMap((line, index) => {
        if (!line.trim()) return [];
        let record;
        try { record = JSON.parse(line); } catch (_) { return []; }
        if (!meaningful.has(record.action)) return [];
        const dedupeKey = `${record.source}|${record.action}|${record.session || ''}|${record.timestamp}`;
        if (seen.has(dedupeKey)) return [];
        seen.add(dedupeKey);
        const source = currentProvider(record.source).short;
        const label = record.action === 'green' ? '任务完成'
          : record.action === 'yellow' ? '等待授权'
            : record.action === 'blue' ? '等待回答' : '发生故障';
        return [{
          id: `hook-${record.timestamp}-${index}`,
          at: record.timestamp,
          kind: record.action,
          message: `${source} · ${label}`,
          source: record.source,
          project: record.project || '',
          detail: record.detail || (record.event === 'RuntimeWatch'
            ? '运行时监听'
            : `${record.event}${record.tool ? ` · ${record.tool}` : ''}`),
        }];
      }).slice(0, limit);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (_) {
    return [];
  }
}

function notificationCategory(action) {
  if (action === 'green') return 'success';
  if (action === 'yellow' || action === 'blue') return 'attention';
  if (action === 'red' || String(action).startsWith('red-')) return 'error';
  return '';
}

function focusTool(source) {
  const provider = currentProvider(source);
  if (isMac) {
    if (provider.appPath && fs.existsSync(provider.appPath)) {
      const opened = spawnSync('/usr/bin/open', [provider.appPath], { timeout: 1500, stdio: 'ignore' });
      if (opened.status === 0) return true;
    }
    for (const candidate of provider.apps) {
      const opened = spawnSync('/usr/bin/open', ['-a', candidate], { timeout: 1500, stdio: 'ignore' });
      if (opened.status === 0) return true;
    }
  } else if (isWindows) {
    if (provider.appPath && fs.existsSync(provider.appPath)) {
      try {
        const launched = spawn(provider.appPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
        launched.unref();
        return true;
      } catch (_) {}
    }
    const title = provider.apps[0] || provider.short;
    const script = `$ws=New-Object -ComObject WScript.Shell; exit([int](-not $ws.AppActivate('${String(title).replaceAll("'", "''")}')))`;
    const focused = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 1500, windowsHide: true });
    if (focused.status === 0) return true;
  }
  mainWindow?.show();
  mainWindow?.focus();
  return false;
}

function maybeNotify(record, force = false) {
  const category = notificationCategory(record?.action);
  if (!category || !Notification.isSupported()) return false;
  if (!force && (!settings.notifications.enabled || !settings.notifications[category])) return false;
  const source = normalizeProviderId(record.source);
  const provider = currentProvider(source);
  if (!force && provider.enabled === false) return false;
  const key = `${source}|${record.action}|${record.session || ''}|${record.timestamp || ''}`;
  const recent = notificationDedupe.get(key);
  if (!force && recent && Date.now() - recent < 2500) return false;
  notificationDedupe.set(key, Date.now());
  if (notificationDedupe.size > 200) {
    const cutoff = Date.now() - 60_000;
    for (const [item, at] of notificationDedupe) if (at < cutoff) notificationDedupe.delete(item);
  }
  const labels = { green: '任务完成', yellow: '等待授权', blue: '需要回答', red: '发生故障' };
  const action = String(record.action).startsWith('red') ? 'red' : record.action;
  const bodies = {
    green: '任务已经完成。点击回到对应工具。',
    yellow: '正在等待权限批准或授权。',
    blue: '需要你的选择、回答或补充输入。',
    red: '网络、认证、额度或工具执行出现故障。',
  };
  const project = String(record.project || '').trim();
  const body = `${project ? `项目 ${project} · ` : ''}${bodies[action] || 'CodeLight 收到新的工具状态。'}`;
  const notification = new Notification({
    title: `${provider.name} · ${labels[action] || '状态更新'}`,
    body,
    icon: provider.icon && fs.existsSync(provider.icon) ? provider.icon : windowIcon(),
    silent: action === 'green',
    urgency: action === 'red' ? 'critical' : 'normal',
  });
  notification.on('click', () => focusTool(source));
  notification.show();
  return true;
}

function pumpHookNotifications() {
  if (!isMac) return;
  try {
    const stat = fs.statSync(HOOK_EVENT_LOG);
    if (stat.size < notificationOffset) notificationOffset = 0;
    if (stat.size === notificationOffset) return;
    const descriptor = fs.openSync(HOOK_EVENT_LOG, 'r');
    try {
      const length = stat.size - notificationOffset;
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, notificationOffset);
      notificationOffset = stat.size;
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { maybeNotify(JSON.parse(line)); } catch (_) {}
      }
    } finally { fs.closeSync(descriptor); }
  } catch (_) {}
}

function startNotificationPump() {
  try { notificationOffset = fs.statSync(HOOK_EVENT_LOG).size; } catch (_) { notificationOffset = 0; }
  setInterval(pumpHookNotifications, 450).unref?.();
}

function windowIcon() {
  const candidate = path.join(__dirname, '..', 'resources', 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#081018',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    icon: windowIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'), {
    query: {
      ...(process.env.CODELIGHT_OPEN_SETTINGS ? { settings: process.env.CODELIGHT_OPEN_SETTINGS } : {}),
      ...(process.env.AGENT_LIGHT_SCREENSHOT ? { screenshot: '1' } : {}),
      ...(process.env.CODELIGHT_SCREENSHOT_FLEET ? { fleet: process.env.CODELIGHT_SCREENSHOT_FLEET } : {}),
      ...(process.env.CODELIGHT_SCREENSHOT_DASHBOARD ? { dashboard: process.env.CODELIGHT_SCREENSHOT_DASHBOARD } : {}),
    },
  });
  mainWindow.once('ready-to-show', () => { if (!startHidden || process.env.AGENT_LIGHT_SCREENSHOT) mainWindow.show(); });
  if (process.env.AGENT_LIGHT_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.resolve(process.env.AGENT_LIGHT_SCREENSHOT), image.toPNG());
        quitting = true;
        app.quit();
      }, Number(process.env.AGENT_LIGHT_SCREENSHOT_DELAY || 2500));
    });
  }
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (isWindows) {
    mainWindow.webContents.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault();
      const preferred = devices.find((device) => device.deviceName?.toUpperCase().includes('JTX-RGB'));
      if (preferred) callback(preferred.deviceId);
      else if (devices[0]) callback(devices[0].deviceId);
    });
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'resources', isMac ? 'trayTemplate.png' : 'icon.png');
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (isMac) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('CodeLight');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制台', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: '立即熄灭', click: () => executeCommand('clear-all').catch(() => {}) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}

function configureBluetoothPermissions() {
  const allowed = (permission) => permission === 'notifications' || (isWindows && permission === 'bluetooth');
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowed(permission));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowed(permission)));
  if (isWindows) session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === 'bluetooth');
}

async function ensureMacBackend() {
  if (!isMac) return;
  try {
    installMacBackend();
    logEvent('system', '蓝牙后台已启动', '由 CodeLight 托管，首次连接将申请蓝牙权限');
  } catch (error) {
    logEvent('system', '蓝牙后台启动失败', error.message);
  }
}

function daemonCommand(command, timeoutMs = 700, port = PORT) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let output = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('后台服务响应超时')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${command.trim()}\n`));
    socket.on('data', (chunk) => { output += chunk; });
    socket.once('end', () => { clearTimeout(timer); resolve(output.trim()); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function parseDaemonStatus(text) {
  const value = Object.fromEntries([...text.matchAll(/([a-z_]+)=([^ ]*)/g)].map((match) => [match[1], match[2]]));
  const active = value.active ? value.active.split(',').filter(Boolean).map((entry) => {
    const match = entry.match(/^(.+)=([a-z]+)(?:@(\d+))?$/);
    return match ? { key: match[1], state: match[2], expiresAt: match[3] ? Number(match[3]) * 1000 : null } : { key: entry, state: '', expiresAt: null };
  }) : [];
  return {
    ok: text.startsWith('OK'),
    displayed: value.displayed || 'off',
    ble: value.ble || 'unavailable',
    chargerSilence: value.charger_silence !== 'off',
    active,
    raw: text,
  };
}

function resolveCodexCLI() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function fetchCodexQuotaFromRPC() {
  return new Promise((resolve, reject) => {
    const executable = resolveCodexCLI();
    if (!executable) {
      reject(new Error('未找到 Codex CLI'));
      return;
    }

    const child = spawn(executable, ['-s', 'read-only', '-a', 'untrusted', 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let settled = false;
    let output = '';
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
    const handleLine = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch (_) { return; }
      if (message.id === 1) {
        if (message.error) return finish(new Error(message.error.message || 'Codex 初始化失败'));
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else if (message.id === 2) {
        if (message.error) return finish(new Error(message.error.message || 'Codex 配额读取失败'));
        finish(null, normalizeCodexQuota(message.result));
      }
    };
    const timer = setTimeout(() => finish(new Error('Codex 配额读取超时')), 12_000);
    child.once('spawn', () => send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'codexlight', version: app.getVersion() } },
    }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      for (const line of lines) handleLine(line);
      if (output.length > 2_000_000) finish(new Error('Codex 返回数据过大'));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1200); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex 配额进程已退出 (${code ?? '?'})`));
    });
  });
}

async function refreshCodexQuota(force = false) {
  if (codexQuotaRequest) return codexQuotaRequest;
  if (!force && codexQuota.updatedAt && Date.now() - codexQuota.updatedAt < CODEX_QUOTA_TTL) return codexQuota;
  const previous = codexQuota;
  codexQuota = { ...previous, status: previous.lanes.length ? 'refreshing' : 'loading', error: '' };
  codexQuotaRequest = fetchCodexQuotaFromRPC()
    .then((value) => { codexQuota = value; return value; })
    .catch((error) => {
      codexQuota = {
        ...previous,
        status: previous.lanes.length ? 'stale' : 'error',
        error: String(error.message || error).slice(0, 160),
      };
      return codexQuota;
    })
    .finally(() => { codexQuotaRequest = null; publishSnapshot(); });
  return codexQuotaRequest;
}

async function currentSnapshot() {
  let backend;
  let devices = [];
  if (isMac) {
    devices = await Promise.all(settings.devices.map(async (device) => {
      try {
        const status = parseDaemonStatus(await daemonCommand('status', 700, device.port));
        return { ...device, status: status.ble, displayed: status.displayed, active: status.active };
      } catch (error) {
        return { ...device, status: 'unavailable', displayed: 'off', active: [], error: error.message };
      }
    }));
    try {
      const primary = devices[0];
      if (!primary) throw new Error('尚未添加跑马灯');
      backend = { ok: primary.status !== 'unavailable', displayed: primary.displayed, ble: primary.status, chargerSilence, active: primary.active || [] };
      bleStatus = {
        state: devices.some((device) => device.status === 'ready') ? 'ready' : primary.status,
        name: devices.length > 1 ? `${devices.filter((device) => device.status === 'ready').length}/${devices.length} 盏灯` : primary.name,
        detail: devices.some((device) => device.status === 'ready') ? 'CoreBluetooth 已连接' : '正在连接灯具',
      };
      chargerSilence = backend.chargerSilence;
    } catch (error) {
      backend = { ok: false, displayed: 'off', ble: 'unavailable', chargerSilence: true, active: [], raw: error.message };
      bleStatus = { state: 'unavailable', name: 'JTX-RGB', detail: error.message };
    }
  } else {
    devices = settings.devices.map((device) => {
      const runtime = windowsRuntimes.get(device.id);
      const live = windowsBleStatuses.get(device.id);
      return { ...device, status: live?.state || 'disconnected', detail: live?.detail || '', ...(runtime?.snapshot() || { displayed: 'off', active: [] }) };
    });
    const readyCount = devices.filter((device) => device.status === 'ready').length;
    bleStatus = {
      state: devices.length > 0 && readyCount === devices.length ? 'ready' : readyCount > 0 ? 'partial' : 'disconnected',
      name: devices.length > 1 ? `${readyCount}/${devices.length} 盏灯` : devices[0]?.name || 'JTX-RGB',
      detail: readyCount === devices.length && devices.length ? '全部设备已连接' : '存在未连接设备',
    };
    backend = { ok: true, ...(windowsRuntimes.get(settings.devices[0]?.id)?.snapshot() || { displayed: 'off', active: [] }), ble: bleStatus.state, chargerSilence };
  }
  return {
    platform: process.platform,
    mode: isMac ? 'macOS CoreBluetooth 后台服务' : 'Windows Web Bluetooth',
    backend,
    ble: bleStatus,
    chargerSilence,
    settings,
    devices,
    providers: presentedProviders(),
    codexQuota,
    providerUsage: { codex: codexQuota, claude: claudeUsage },
    events: [...eventLog, ...readHookEvents()]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 200),
    hooks: inspectHooks(),
    adapters: inspectAdapters(),
    version: app.getVersion(),
  };
}

async function publishSnapshot() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const next = await currentSnapshot();
    mainWindow.webContents.send('state:snapshot', next);
    updateConnectionGuard(next);
  } catch (_) {}
}

function snapshotHasConnection(next) {
  const enabled = (next.devices || []).filter((device) => device.enabled !== false);
  return enabled.length > 0 && enabled.every((device) => device.status === 'ready');
}

function updateConnectionGuard(next) {
  if (process.env.AGENT_LIGHT_SCREENSHOT) return;
  const ready = snapshotHasConnection(next);
  const firstCheck = !connectionGuardInitialized;
  const enabled = (next.devices || []).filter((device) => device.enabled !== false);
  const unready = enabled.filter((device) => device.status !== 'ready');
  const droppedDevices = unready.filter((device) => deviceConnectionStates.get(device.id) === 'ready');
  const dropped = droppedDevices.length > 0 || (connectionGuardInitialized && connectionWasReady && !ready);
  for (const device of enabled) deviceConnectionStates.set(device.id, device.status);
  connectionGuardInitialized = true;
  connectionWasReady = ready;
  if (ready) return;
  if (!firstCheck && !dropped) return;
  const now = Date.now();
  if (now - lastConnectionAlertAt < 10_000) return;
  lastConnectionAlertAt = now;
  const affected = (droppedDevices.length ? droppedDevices : unready).map((device) => device.name).join('、');
  const reason = dropped ? '掉线' : '启动时未连接';
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('connection:required', { reason, dropped, devices: affected, at: new Date().toISOString() });
  if (dropped && Notification.isSupported()) {
    const notification = new Notification({
      title: 'CodeLight · 跑马灯已断开',
      body: `点击重新连接 ${affected || 'JTX-RGB'}，状态提醒将在连接恢复后继续。`,
      icon: windowIcon(),
      urgency: 'critical',
    });
    notification.on('click', () => {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('connection:required', { reason, dropped, devices: affected, at: new Date().toISOString() });
    });
    notification.show();
  }
}

async function executeCommand(command) {
  if (isMac) {
    const targets = settings.devices.filter((device) => device.enabled);
    if (!targets.length) throw new Error('尚未添加跑马灯');
    const selected = command.trim() === 'status' ? targets.slice(0, 1) : targets;
    const responses = await Promise.all(selected.map((device) => daemonCommand(command, 700, device.port)));
    const failed = responses.find((response) => !response.startsWith('OK'));
    if (failed) throw new Error(failed || '命令失败');
    const response = responses.join(' | ');
    logEvent('command', command, response);
    return response;
  }
  const response = handleLocalCommand(command);
  logEvent('command', command, response);
  return response;
}

function handleLocalCommand(raw) {
  const parts = raw.trim().split(/\s+/);
  const verb = parts[0]?.toLowerCase();
  const runtimes = [...windowsRuntimes.values()];
  const primary = windowsRuntimes.get(settings.devices[0]?.id) || runtimes[0];
  if (verb === 'ping') return 'OK pong';
  if (verb === 'status') return `OK displayed=${primary?.displayed || 'off'} ble=${bleStatus.state} charger_silence=${chargerSilence ? 'on' : 'off'} active=${(primary?.snapshot().active || []).map((entry) => `${entry.key}=${entry.state}`).join(',')}`;
  if (verb === 'set' && parts.length >= 3) {
    const force = parts[4]?.toLowerCase() === 'force';
    runtimes.forEach((runtime) => runtime.set(parts[1], parts[2], Number(parts[3] || 600), force));
    return `OK set ${parts[1]} ${parts[2]}`;
  }
  if (verb === 'clear' && parts[1]) { runtimes.forEach((runtime) => runtime.clear(parts[1])); return `OK clear ${parts[1]}`; }
  if (verb === 'activity' && parts[1]) { runtimes.forEach((runtime) => runtime.activity(parts[1])); return `OK activity ${parts[1]}`; }
  if (verb === 'clear-all' || verb === 'off') { runtimes.forEach((runtime) => runtime.clearAll()); return 'OK off'; }
  if (verb === 'demo' && ['green', 'blue', 'yellow', 'red'].includes(parts[1])) {
    runtimes.forEach((runtime) => runtime.set('manual-demo', parts[1], 3600, true));
    return `OK demo ${parts[1]}`;
  }
  if (verb === 'charger-silence' && ['on', 'off'].includes(parts[1])) {
    chargerSilence = parts[1] === 'on';
    mainWindow?.webContents.send('charger:mode', { silence: chargerSilence });
    return `OK charger-silence ${parts[1]}`;
  }
  if (verb === 'charger-status') {
    const seconds = Math.min(300, Math.max(1, Number(parts[1] || 10)));
    chargerSilence = false;
    mainWindow?.webContents.send('charger:mode', { silence: false });
    setTimeout(() => {
      chargerSilence = true;
      mainWindow?.webContents.send('charger:mode', { silence: true });
      publishSnapshot();
    }, seconds * 1000).unref?.();
    return `OK charger-status visible-for=${seconds}s`;
  }
  return 'ERR unknown command';
}

function handleHook(source, payload) {
  const normalized = normalizeProviderId(source);
  if (currentProvider(normalized).enabled === false) return { source: normalized, action: 'ignore', event: 'ProviderDisabled' };
  const mapped = mapHookEvent(normalized, payload, { durationSeconds: settings.statusDurationSeconds });
  const projectPath = [payload?.project, payload?.project_dir, payload?.workspace, payload?.workspace_path, payload?.cwd]
    .find((value) => typeof value === 'string' && value.trim());
  const project = projectPath ? path.basename(projectPath) : '';
  for (const device of devicesForSource(settings, normalized)) windowsRuntimes.get(device.id)?.applyMapped(mapped);
  logEvent('hook', `${currentProvider(normalized).short} · ${mapped.event || 'unknown'}`, `${project ? `${project} · ` : ''}${mapped.action === 'set' ? `${mapped.state} · ${mapped.tool || 'session'}` : mapped.action}`);
  const notificationAction = mapped.action === 'set' ? mapped.state
    : mapped.action === 'session-end' && mapped.failed ? 'red' : '';
  maybeNotify({ source: normalized, action: notificationAction, event: mapped.event, session: mapped.key, project, timestamp: new Date().toISOString() });
  return mapped;
}

function startWindowsHookServer() {
  if (!isWindows) return;
  hookServer = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 2_000_000) socket.destroy();
    });
    socket.on('end', () => {
      try {
        const line = input.trim();
        if (line.startsWith('hook-json ')) {
          const [, source, encoded] = line.split(/\s+/, 3);
          const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
          handleHook(source, payload);
          socket.end('OK hook\n');
        } else {
          socket.end(`${handleLocalCommand(line)}\n`);
        }
      } catch (error) {
        socket.end(`ERR ${error.message}\n`);
      }
    });
  });
  hookServer.on('error', (error) => logEvent('error', 'Hook 服务启动失败', error.message));
  hookServer.listen(PORT, '127.0.0.1', () => logEvent('system', 'Windows Hook 服务已启动', `127.0.0.1:${PORT}`));
}

function hookPaths() {
  return {
    claude: path.join(os.homedir(), '.claude', 'settings.json'),
    codex: path.join(os.homedir(), '.codex', 'hooks.json'),
  };
}

function inspectHooks() {
  const result = {};
  for (const [name, file] of Object.entries(hookPaths())) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const directInstalled = text.includes('agent-light-hook');
      result[name] = {
        installed: directInstalled || text.includes('ping-island-bridge') || text.includes('coffee-cli-hook'),
        directInstalled,
        path: file,
      };
    } catch (_) {
      result[name] = { installed: false, directInstalled: false, path: file };
    }
  }
  return result;
}

function windowsHookScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'agent-light-hook.ps1')
    : path.join(__dirname, '..', 'scripts', 'agent-light-hook.ps1');
}

function windowsBridgeScriptPath() {
  return path.join(os.homedir(), '.agent-status-light', 'bin', 'codelight-hook.ps1');
}

function installWindowsBridge() {
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'integrations', 'codelight-hook.ps1')
    : path.join(__dirname, '..', 'resources', 'integrations', 'codelight-hook.ps1');
  const target = windowsBridgeScriptPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function macBackendPaths() {
  const sourceRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
  return {
    daemonSource: app.isPackaged
      ? path.join(sourceRoot, 'backend', 'macos', 'agent-light-daemon')
      : path.join(sourceRoot, '.build', 'agent-light-daemon'),
    hookSource: app.isPackaged
      ? path.join(sourceRoot, 'backend', 'agent_light.py')
      : path.join(sourceRoot, 'agent_light.py'),
    watchSource: app.isPackaged
      ? path.join(sourceRoot, 'backend', 'status_watch.py')
      : path.join(sourceRoot, 'status_watch.py'),
    deviceSource: app.isPackaged
      ? path.join(sourceRoot, 'backend', 'device.id')
      : path.join(sourceRoot, 'device.id'),
    installRoot: path.join(os.homedir(), '.agent-status-light'),
  };
}

function installMacBackend() {
  const paths = macBackendPaths();
  const bin = path.join(paths.installRoot, 'bin');
  const logs = path.join(paths.installRoot, 'logs');
  const hookTarget = path.join(bin, 'agent-light-hook');
  const watchTarget = path.join(bin, 'agent-light-watch');
  for (const required of [paths.daemonSource, paths.hookSource, paths.watchSource]) {
    if (!fs.existsSync(required)) throw new Error(`安装文件不存在：${required}`);
  }
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  // Re-sign a staging copy with a stable designated requirement. Otherwise
  // the linker's one-build CDHash makes macOS ask for Bluetooth permission
  // again after every backend upgrade. The signed hash also gives launchd a
  // new immutable executable path whenever the backend really changes.
  const daemonStage = path.join(bin, `.agent-light-daemon-stage-${process.pid}`);
  fs.copyFileSync(paths.daemonSource, daemonStage);
  fs.chmodSync(daemonStage, 0o755);
  const signed = spawnSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--identifier', 'com.local.codelight.ble-helper',
    '--requirements', '=designated => identifier "com.local.codelight.ble-helper"', daemonStage,
  ], { timeout: 5000, encoding: 'utf8' });
  if (signed.status !== 0) {
    fs.unlinkSync(daemonStage);
    throw new Error(String(signed.stderr || '无法签名蓝牙后台').trim());
  }
  const daemonHash = crypto.createHash('sha256').update(fs.readFileSync(daemonStage)).digest('hex').slice(0, 12);
  const daemonTarget = path.join(bin, `agent-light-daemon-${daemonHash}`);
  if (!fs.existsSync(daemonTarget)) fs.renameSync(daemonStage, daemonTarget);
  else fs.unlinkSync(daemonStage);
  fs.copyFileSync(paths.hookSource, hookTarget);
  fs.copyFileSync(paths.watchSource, watchTarget);
  fs.chmodSync(daemonTarget, 0o755);
  fs.chmodSync(hookTarget, 0o755);
  fs.chmodSync(watchTarget, 0o755);
  if (!settings.devices.length) throw new Error('请先添加至少一盏 JTX-RGB 跑马灯');
  for (const device of settings.devices) {
    if (!/^[0-9a-f-]{36}$/i.test(device.id)) throw new Error(`设备 ID 格式错误：${device.name}`);
  }
  saveSettings(settings);
  fs.writeFileSync(path.join(paths.installRoot, 'device.id'), `${settings.devices[0].id}\n`);
  const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const watchPlist = path.join(launchAgents, `${WATCH_LABEL}.plist`);
  fs.mkdirSync(launchAgents, { recursive: true });
  const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const watchPlistText = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${WATCH_LABEL}</string>
<key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${escapeXml(watchTarget)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${escapeXml(path.join(logs, 'watch.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXml(path.join(logs, 'watch-error.log'))}</string>
</dict></plist>\n`;
  fs.writeFileSync(watchPlist, watchPlistText);
  const domain = `gui/${process.getuid()}`;
  // The BLE helpers are children of CodeLight rather than headless launchd
  // jobs. This keeps the macOS Bluetooth permission attributed to CodeLight,
  // so the prompt is visible and one grant covers every bound lamp.
  const legacyPlists = fs.readdirSync(launchAgents).filter((name) => (name === `${LABEL}.plist` || name.startsWith(`${LABEL}.device-`)) && name.endsWith('.plist'));
  for (const file of legacyPlists) {
    const label = file.slice(0, -6);
    spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { timeout: 1800 });
    fs.unlinkSync(path.join(launchAgents, file));
  }
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${WATCH_LABEL}`], { timeout: 1800 });
  const started = spawnSync('/bin/launchctl', ['bootstrap', domain, watchPlist], { timeout: 2500, encoding: 'utf8' });
  if (started.status !== 0 && !String(started.stderr).includes('service already loaded')) {
    throw new Error(String(started.stderr || '无法启动事件监听后台').trim());
  }
  spawnSync('/bin/launchctl', ['kickstart', `${domain}/${WATCH_LABEL}`], { timeout: 1800 });
  startMacDaemons(daemonTarget, logs);
  return hookTarget;
}

function stopMacDaemons() {
  macDaemonGeneration += 1;
  for (const child of macDaemonProcesses.values()) child.kill('SIGTERM');
  macDaemonProcesses.clear();
}

function startMacDaemons(executable, logs) {
  stopMacDaemons();
  const generation = macDaemonGeneration;
  const launch = (device, index) => {
    if (quitting || generation !== macDaemonGeneration) return;
    const suffix = device.id.replaceAll('-', '').slice(0, 12).toLowerCase();
    const stdout = fs.openSync(path.join(logs, index === 0 ? 'daemon.log' : `daemon-${suffix}.log`), 'a');
    const stderr = fs.openSync(path.join(logs, index === 0 ? 'daemon-error.log' : `daemon-${suffix}-error.log`), 'a');
    const child = spawn(executable, [device.id, String(device.port)], { stdio: ['ignore', stdout, stderr] });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    macDaemonProcesses.set(device.id, child);
    child.once('exit', () => {
      if (macDaemonProcesses.get(device.id) !== child) return;
      macDaemonProcesses.delete(device.id);
      if (!quitting && generation === macDaemonGeneration && settings.devices.some((item) => item.enabled && item.id === device.id)) {
        setTimeout(() => launch(device, index), 1200).unref?.();
      }
    });
  };
  settings.devices.filter((device) => device.enabled).forEach(launch);
}

function addHookGroups(file, source, command) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    fs.copyFileSync(file, `${file}.before-agent-light-app`);
    data = JSON.parse(raw);
  }
  // Keep each file inside the event vocabulary supported by that client.
  // Unknown Codex hook names make the entire hooks file fail validation.
  data = mergeHookGroups(data, source, command);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { source, file };
}

function installHooks() {
  if (isWindows) {
    installWindowsBridge();
    const script = windowsHookScriptPath();
    const paths = hookPaths();
    addHookGroups(paths.claude, 'claude', `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}" -Source claude`);
    addHookGroups(paths.codex, 'codex', `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}" -Source codex`);
    logEvent('system', 'Claude/Codex Hooks 已写入', 'Codex 首次使用请在 /hooks 中确认信任');
    return { ok: true, message: 'Hooks 已安装；Codex 请打开 /hooks 确认信任。' };
  }
  try {
    const existingIntegration = inspectHooks();
    // Installing adapters also upgrades and restarts the app-owned BLE helpers.
    const hook = installMacBackend();
    const paths = hookPaths();
    // Claude's local Agent/Cowork can end without the third-party relays
    // running, so always keep a direct low-latency fallback there.
    if (!existingIntegration.claude.directInstalled) addHookGroups(paths.claude, 'claude', `"${hook}" --source claude`);
    // Existing Codex relays are already trusted by Codex. Avoid adding a new
    // hook identity unless Codex has no integration at all.
    if (!existingIntegration.codex.installed) addHookGroups(paths.codex, 'codex', `"${hook}" --source codex`);
    return { ok: true, message: 'macOS 后台服务和 Claude/Codex Hooks 已安装。' };
  } catch (error) {
    return { ok: false, message: `安装失败：${error.message}` };
  }
}

function integrationTemplate(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'resources', 'integrations', name), 'utf8');
}

function genericHookCommand(source, hookPath = path.join(os.homedir(), '.agent-status-light', 'bin', 'agent-light-hook')) {
  if (isWindows) {
    const installed = windowsBridgeScriptPath();
    const script = fs.existsSync(installed) ? installed : (app.isPackaged
      ? path.join(process.resourcesPath, 'integrations', 'codelight-hook.ps1')
      : path.join(__dirname, '..', 'resources', 'integrations', 'codelight-hook.ps1'));
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}" -Source ${source}`;
  }
  return `"${hookPath}" --source ${source}`;
}

function providerBridgeCommand(source) {
  if (isWindows) return `${genericHookCommand(source)} -Event EVENT -Session PROJECT`;
  const hook = path.join(os.homedir(), '.agent-status-light', 'bin', 'agent-light-hook');
  return `"${hook}" --emit ${source} EVENT --session PROJECT`;
}

function mergeCompatibleHooks(file, events, command) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) data = JSON.parse(raw);
    fs.copyFileSync(file, `${file}.before-codelight`);
  }
  data.hooks ||= {};
  for (const event of events) {
    data.hooks[event] ||= [];
    const exists = data.hooks[event].some((group) => (group.hooks || []).some((hook) => hook.command === command));
    if (!exists) data.hooks[event].push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 2, async: true }] });
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function installOpenCodePlugin(source, directories) {
  const content = integrationTemplate('opencode-codelight.js').replaceAll('__CODELIGHT_SOURCE__', source);
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'codelight.js'), content);
  }
}

function installHermesAdapter(command) {
  const file = path.join(os.homedir(), '.hermes', 'config.yaml');
  if (!fs.existsSync(file)) return false;
  const YAML = require('yaml');
  const document = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const hooks = document.get('hooks', true) || document.createNode({});
  if (!document.has('hooks')) document.set('hooks', hooks);
  for (const event of ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_llm_call', 'on_session_end']) {
    const current = document.getIn(['hooks', event], true)?.toJSON?.() || [];
    if (!current.some((item) => item?.command === command)) current.push({ command, timeout: 2 });
    document.setIn(['hooks', event], current);
  }
  fs.copyFileSync(file, `${file}.before-codelight`);
  fs.writeFileSync(file, String(document));
  return true;
}

function prepareZCodePlugin(command) {
  const root = path.join(os.homedir(), '.agent-status-light', 'integrations', 'zcode-codelight');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), `${JSON.stringify({ name: 'codelight', version: '1.0.0', description: 'CodeLight status and notification bridge' }, null, 2)}\n`);
  const hooks = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
    hooks[event] = [{ matcher: '*', hooks: [{ type: 'command', command, async: true, timeout: 2 }] }];
  }
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), `${JSON.stringify({ hooks }, null, 2)}\n`);
  return root;
}

function installAllAdapters() {
  const base = installHooks();
  if (!base.ok) return base;
  const hookPath = path.join(os.homedir(), '.agent-status-light', 'bin', 'agent-light-hook');
  const standardEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SessionEnd'];
  const installed = ['claude', 'codex'];
  try {
    installOpenCodePlugin('opencode', [path.join(os.homedir(), '.config', 'opencode', 'plugins')]);
    installed.push('opencode');
    installOpenCodePlugin('mimo', [
      path.join(os.homedir(), '.config', 'mimo', 'plugins'),
      path.join(os.homedir(), '.config', 'mimocode', 'plugins'),
      path.join(os.homedir(), '.mimocode', 'plugins'),
    ]);
    installed.push('mimo');
    if (installHermesAdapter(genericHookCommand('hermes', hookPath))) installed.push('hermes');
    mergeCompatibleHooks(path.join(os.homedir(), '.qwen', 'settings.json'), standardEvents, genericHookCommand('qwen', hookPath));
    installed.push('qwen');
    mergeCompatibleHooks(path.join(os.homedir(), '.gemini', 'settings.json'), ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'Notification', 'SessionEnd'], genericHookCommand('gemini', hookPath));
    installed.push('gemini');
    mergeCompatibleHooks(path.join(os.homedir(), '.copilot', 'hooks', 'codelight.json'), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'], genericHookCommand('copilot', hookPath));
    installed.push('copilot');
    prepareZCodePlugin(genericHookCommand('zcode', hookPath));
    installed.push('zcode');
    logEvent('system', 'CodeLight 工具适配器已安装', installed.join(', '));
    return { ok: true, message: `已接入 ${installed.length} 个工具；其他工具可使用通用事件桥。`, installed };
  } catch (error) {
    return { ok: false, message: `基础 Hooks 已安装，扩展适配器失败：${error.message}`, installed };
  }
}

function inspectAdapters() {
  const paths = {
    opencode: path.join(os.homedir(), '.config', 'opencode', 'plugins', 'codelight.js'),
    mimo: path.join(os.homedir(), '.mimocode', 'plugins', 'codelight.js'),
    hermes: path.join(os.homedir(), '.hermes', 'config.yaml'),
    qwen: path.join(os.homedir(), '.qwen', 'settings.json'),
    gemini: path.join(os.homedir(), '.gemini', 'settings.json'),
    copilot: path.join(os.homedir(), '.copilot', 'hooks', 'codelight.json'),
    zcode: path.join(os.homedir(), '.agent-status-light', 'integrations', 'zcode-codelight', 'plugin.json'),
  };
  return Object.fromEntries(settings.providers.map((provider) => [provider.id, {
    installed: provider.id === 'claude' || provider.id === 'codex'
      ? Boolean(inspectHooks()[provider.id]?.installed)
      : paths[provider.id] ? fs.existsSync(paths[provider.id]) : false,
    tier: provider.tier,
    path: paths[provider.id] || '',
  }]));
}

async function scanMacDevices() {
  if (!isMac) return [];
  const primary = settings.devices[0];
  if (!primary) throw new Error('请先保留一盏已绑定设备用于扫描');
  await daemonCommand('scan 5', 900, primary.port);
  await new Promise((resolve) => setTimeout(resolve, 5200));
  const response = await daemonCommand('devices', 900, primary.port);
  const encoded = response.match(/devices=([^ ]+)/)?.[1];
  if (!encoded) throw new Error(response || '没有发现设备');
  const found = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  return found.map((device) => ({
    ...device,
    configured: settings.devices.some((item) => item.id.toLowerCase() === String(device.id).toLowerCase()),
  }));
}

function upsertDevice(input) {
  const id = String(input?.id || '').trim();
  if (!id) throw new Error('缺少设备 ID');
  if (isMac && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('macOS 蓝牙设备 ID 格式错误');
  const existing = settings.devices.findIndex((device) => device.id === id);
  const previous = existing >= 0 ? settings.devices[existing] : null;
  const device = normalizeDevice({
    ...(existing >= 0 ? settings.devices[existing] : {}),
    id,
    name: input.name,
    enabled: input.enabled,
    sources: input.sources,
  }, existing >= 0 ? existing : settings.devices.length);
  const devices = [...settings.devices];
  if (existing >= 0) devices[existing] = device;
  else {
    devices.push(device);
  }
  saveSettings({ ...settings, devices });
  if (isMac && (!previous || previous.enabled !== device.enabled)) installMacBackend();
  return settings;
}

function removeDevice(id) {
  if (settings.devices.length <= 1) throw new Error('至少保留一盏设备');
  const devices = settings.devices.filter((device) => device.id !== id);
  if (devices.length === settings.devices.length) throw new Error('设备不存在');
  saveSettings({ ...settings, devices });
  if (isMac) installMacBackend();
  return settings;
}

function registerIPC() {
  ipcMain.handle('state:get', () => currentSnapshot());
  ipcMain.handle('light:command', (_event, command) => executeCommand(command));
  ipcMain.handle('hooks:install', () => installAllAdapters());
  ipcMain.handle('quota:refresh', async () => {
    await Promise.all([refreshClaudeUsage(), refreshCodexQuota(true)]);
    return { codex: codexQuota, claude: claudeUsage };
  });
  ipcMain.handle('external:open', (_event, url) => shell.openExternal(url));
  ipcMain.handle('devices:scan', () => scanMacDevices());
  ipcMain.handle('devices:save', (_event, device) => upsertDevice(device));
  ipcMain.handle('devices:remove', (_event, id) => removeDevice(String(id || '')));
  ipcMain.handle('devices:test', async (_event, { id, color }) => {
    if (!['green', 'yellow', 'blue', 'red'].includes(color)) throw new Error('无效颜色');
    const device = settings.devices.find((item) => item.id === id);
    if (!device) throw new Error('设备不存在');
    if (isMac) return daemonCommand(`demo ${color}`, 900, device.port);
    windowsRuntimes.get(id)?.set('manual-demo', color, 3600, true);
    return 'OK demo';
  });
  ipcMain.handle('settings:update', (_event, patch) => {
    const notifications = { ...settings.notifications, ...(patch?.notifications || {}) };
    return saveSettings({
      ...settings,
      notifications,
      providers: Array.isArray(patch?.providers) ? patch.providers : settings.providers,
      statusDurationSeconds: patch?.statusDurationSeconds ?? settings.statusDurationSeconds,
    });
  });
  ipcMain.handle('files:choose-icon', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择 Provider 图标', properties: ['openFile'], filters: [{ name: '图标', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }] });
    return result.canceled ? '' : result.filePaths[0] || '';
  });
  ipcMain.handle('files:choose-app', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择通知点击后打开的软件', properties: ['openFile', 'openDirectory'] });
    return result.canceled ? '' : result.filePaths[0] || '';
  });
  ipcMain.handle('notification:test', (_event, source = 'codex') => maybeNotify({ source, action: 'blue', session: 'notification-test', timestamp: new Date().toISOString() }, true));
  ipcMain.handle('tool:focus', (_event, source) => focusTool(source));
  ipcMain.on('ble:status', (_event, status) => {
    const id = String(status?.deviceId || status?.id || '').trim();
    if (id) windowsBleStatuses.set(id, { ...status, id });
    else bleStatus = { ...bleStatus, ...status };
    publishSnapshot();
  });
  ipcMain.on('window:hide', () => mainWindow?.hide());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(() => {
    app.setName('CodeLight');
    saveSettings(settings);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    configureBluetoothPermissions();
    registerIPC();
    createWindow();
    createTray();
    if (!process.env.AGENT_LIGHT_SCREENSHOT) ensureMacBackend().then(publishSnapshot);
    startWindowsHookServer();
    startNotificationPump();
    claudeUsage = readClaudeUsageSnapshot();
    refreshClaudeUsage();
    refreshCodexQuota(true);
    setInterval(() => refreshCodexQuota(), CODEX_QUOTA_TTL).unref?.();
    setInterval(() => refreshClaudeUsage(), CODEX_QUOTA_TTL).unref?.();
    setInterval(publishSnapshot, 1500).unref?.();
  });
}

app.on('before-quit', () => { quitting = true; stopMacDaemons(); for (const runtime of windowsRuntimes.values()) runtime.close(); hookServer?.close(); });
app.on('activate', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
app.on('window-all-closed', () => { if (!isMac) { /* tray keeps the app alive */ } });
