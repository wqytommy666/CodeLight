'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    connectionBadge: $('#connectionBadge'), backendMode: $('#backendMode'), currentState: $('#currentState'),
    currentReason: $('#currentReason'), lampFleet: $('#lampFleet'), agentStrip: $('#agentStrip'), routeBadge: $('#routeBadge'),
    connectButton: $('#connectButton'), offButton: $('#offButton'), chargerToggle: $('#chargerToggle'),
    autoRouteButton: $('#autoRouteButton'),
    chargerBadge: $('#chargerBadge'), previewCharge: $('#previewCharge'), hookState: $('#hookState'),
    installHooks: $('#installHooks'), eventLog: $('#eventLog'), refreshButton: $('#refreshButton'),
    footerVersion: $('#footerVersion'), hideWindow: $('#hideWindow'), toastRegion: $('#toastRegion'),
    quotaPlan: $('#quotaPlan'), quotaLanes: $('#quotaLanes'), quotaCredits: $('#quotaCredits'),
    quotaUpdated: $('#quotaUpdated'), refreshQuota: $('#refreshQuota'), quotaProviderSelect: $('#quotaProviderSelect'),
    quotaProviderTabs: $('#quotaProviderTabs'),
    quotaProviderIcon: $('#quotaProviderIcon'), quotaProviderName: $('#quotaProviderName'),
    connectionModal: $('#connectionModal'), connectionModalTitle: $('#connectionModalTitle'),
    connectionModalMessage: $('#connectionModalMessage'), connectionDeviceList: $('#connectionDeviceList'),
    connectionLater: $('#connectionLater'), connectionNow: $('#connectionNow'),
    settingsButton: $('#settingsButton'), settingsModal: $('#settingsModal'), settingsClose: $('#settingsClose'),
    durationSelect: $('#durationSelect'), notificationEnabled: $('#notificationEnabled'),
    notificationSuccess: $('#notificationSuccess'), notificationAttention: $('#notificationAttention'),
    notificationError: $('#notificationError'), saveGeneral: $('#saveGeneral'),
    providerCount: $('#providerCount'), providerList: $('#providerList'), addProvider: $('#addProvider'),
    providerForm: $('#providerForm'), providerEditorTitle: $('#providerEditorTitle'), providerIconPreview: $('#providerIconPreview'),
    providerId: $('#providerId'), providerName: $('#providerName'), providerShort: $('#providerShort'),
    providerAccent: $('#providerAccent'), providerIcon: $('#providerIcon'), providerAppPath: $('#providerAppPath'),
    providerEnabled: $('#providerEnabled'), providerPinned: $('#providerPinned'), providerBridgeCommand: $('#providerBridgeCommand'),
    chooseProviderIcon: $('#chooseProviderIcon'), chooseProviderApp: $('#chooseProviderApp'),
    deleteProvider: $('#deleteProvider'), testProviderNotification: $('#testProviderNotification'),
    scanDevices: $('#scanDevices'), deviceManagerList: $('#deviceManagerList'), deviceScanResults: $('#deviceScanResults'),
    fullEventLog: $('#fullEventLog'), refreshFullEvents: $('#refreshFullEvents'),
  };

  const stateLabels = { off: '熄灭', green: '任务完成', yellow: '网络重试', blue: '需要人工处理', red: '发生故障' };
  const stateReasons = {
    off: '没有待处理状态', green: '完成状态持续显示，新事件会重新计时', yellow: 'Agent 正在重试网络，请检查或切换网络',
    blue: '等待回答、选择、审批或授权', red: '最终任务、认证或额度故障',
  };
  const query = new URLSearchParams(location.search);
  let snapshot = null;
  const bleControllers = new Map();
  let chargerPreviewTimer = null;
  let connectionInitialized = false;
  let connectionWasReady = false;
  let connectionPromptDismissed = false;
  let connectionBusy = false;
  let selectedProviderId = '';
  let selectedDashboardProvider = query.get('dashboard') || localStorage.getItem('codelight.dashboard-provider') || 'claude';
  let providerIsNew = false;
  let windowsBluetoothTarget = 'modal';
  let windowsBluetoothSelecting = false;
  let windowsAdaptersInstalled = false;
  const screenshotMode = query.get('screenshot') === '1';
  const screenshotFleetCount = Math.max(0, Math.min(24, Number(query.get('fleet') || 0)));

  function toast(message, error = false) {
    const item = document.createElement('div');
    item.className = `toast${error ? ' error' : ''}`;
    item.textContent = message;
    elements.toastRegion.append(item);
    setTimeout(() => item.remove(), 3200);
  }

  function setConnection(status) {
    const ready = status?.state === 'ready';
    const released = status?.state === 'released';
    const failed = ['unavailable', 'error'].includes(status?.state);
    elements.connectionBadge.className = `connection-badge ${ready ? 'ready' : failed ? 'error' : 'pending'}`;
    elements.connectionBadge.querySelector('span').textContent = ready ? `${status?.name || 'JTX-RGB'} 已连接` : released ? '蓝牙已释放' : failed ? '后台不可用' : '等待连接';
    elements.connectButton.textContent = ready || released ? '管理蓝牙设备' : '连接蓝牙设备';
  }

  function snapshotConnected(value = snapshot) {
    const enabled = (value?.devices || []).filter((device) => device.enabled !== false);
    return enabled.length > 0 && enabled.every((device) => device.status === 'ready');
  }

  function showConnectionModal({ dropped = false, devices = '' } = {}) {
    connectionPromptDismissed = false;
    elements.connectionModalTitle.textContent = dropped ? `${devices || '跑马灯'} 蓝牙已断开` : '连接蓝牙跑马灯';
    elements.connectionModalMessage.textContent = dropped
      ? '请确认跑马灯已开机并在电脑附近，然后重新搜索并连接。连接恢复前不会漏记软件状态。'
      : '打开跑马灯并保持在电脑附近，然后搜索蓝牙设备并点击连接。';
    elements.connectionDeviceList.replaceChildren();
    elements.connectionNow.textContent = '搜索蓝牙设备';
    elements.connectionNow.disabled = false;
    elements.connectionModal.hidden = false;
    elements.connectionNow.focus();
  }

  function hideConnectionModal(dismissed = false) {
    elements.connectionModal.hidden = true;
    connectionPromptDismissed = dismissed;
  }

  function updateConnectionGuard(next) {
    if (screenshotMode) return;
    const enabled = (next?.devices || []).filter((device) => device.enabled !== false);
    if (!enabled.length) {
      connectionInitialized = true;
      connectionWasReady = false;
      hideConnectionModal(false);
      return;
    }
    const ready = snapshotConnected(next);
    if (ready) {
      connectionWasReady = true;
      connectionPromptDismissed = false;
      hideConnectionModal(false);
    } else if (connectionInitialized && connectionWasReady) {
      connectionWasReady = false;
      showConnectionModal({ dropped: true });
    } else if (!connectionInitialized) {
      connectionWasReady = false;
      setTimeout(() => {
        if (!snapshotConnected() && !connectionPromptDismissed) showConnectionModal();
      }, 900);
    }
    connectionInitialized = true;
  }

  function renderLight(state) {
    const safe = ['green', 'yellow', 'blue', 'red'].includes(state) ? state : 'off';
    elements.currentState.textContent = stateLabels[safe];
    if (safe === 'green') {
      const seconds = snapshot?.settings?.statusDurationSeconds ?? 60;
      elements.currentReason.textContent = seconds === 0 ? '一直亮到手动处理' : `保持 ${seconds} 秒，新事件会重新计时`;
    } else {
      elements.currentReason.textContent = stateReasons[safe];
    }
  }

  function providerFor(id) {
    return snapshot?.providers?.find((provider) => provider.id === id);
  }

  function remainingLabel(device) {
    if (device.displayed === 'off') return device.status === 'ready' ? '空闲' : '等待连接';
    const active = (device.active || []).find((entry) => entry.state === device.displayed && entry.expiresAt);
    if (!active) return stateLabels[device.displayed] || device.displayed;
    const seconds = Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000));
    if ((snapshot?.settings?.statusDurationSeconds ?? 60) === 0 || seconds > 31_536_000) return `${stateLabels[device.displayed]} · 手动处理`;
    return `${stateLabels[device.displayed]} · ${seconds}s`;
  }

  function renderFleet(devices = snapshot?.devices || [], burstDeviceId = '') {
    const enabled = devices.filter((device) => device.enabled !== false);
    const maximumCards = 6;
    const hasOverflow = enabled.length > maximumCards;
    const visible = hasOverflow ? enabled.slice(0, maximumCards - 1) : enabled.slice(0, maximumCards);
    const renderedCount = visible.length + (hasOverflow ? 1 : 0);
    elements.lampFleet.className = `lamp-fleet count-${renderedCount}${renderedCount <= 1 ? ' single' : ''}${renderedCount > 6 ? ' dense' : ''}`;
    elements.lampFleet.dataset.count = String(enabled.length);
    const specificallyBound = enabled.filter((device) => device.sources?.[0] && device.sources[0] !== '*').length;
    elements.routeBadge.textContent = enabled.length
      ? `${enabled.length} 盏灯 · ${specificallyBound}/${enabled.length} 独立绑定`
      : '等待设备路由';
    elements.autoRouteButton.disabled = !enabled.length || !(snapshot?.providers || []).some((provider) => provider.enabled !== false);
    elements.autoRouteButton.textContent = enabled.length > 1 ? `一一绑定 ${enabled.length} 盏` : '绑定软件';
    if (!enabled.length) {
      const empty = document.createElement('div');
      empty.className = 'device-manager-empty';
      empty.textContent = '尚未添加实体灯';
      elements.lampFleet.replaceChildren(empty);
      renderLight('off');
      return;
    }
    const priority = { off: 0, green: 1, blue: 2, yellow: 3, red: 4 };
    const highest = enabled.reduce((winner, device) => priority[device.displayed] > priority[winner] ? device.displayed : winner, 'off');
    renderLight(highest);
    elements.currentReason.textContent = `${enabled.filter((device) => device.status === 'ready').length}/${enabled.length} 盏已连接 · 独立 Agent 路由`;
    const cards = visible.map((device) => {
      const state = ['green', 'yellow', 'blue', 'red'].includes(device.displayed) ? device.displayed : 'off';
      const card = document.createElement('article');
      card.className = `fleet-lamp ${state}${device.status === 'ready' ? ' ready' : ''}${device.id === burstDeviceId && state !== 'off' ? ' burst' : ''}`;
      const copy = document.createElement('div');
      copy.className = 'fleet-lamp-copy';
      const title = document.createElement('div');
      title.className = 'fleet-lamp-title';
      const dot = document.createElement('i');
      const name = document.createElement('strong');
      name.textContent = device.name;
      const connection = document.createElement('span');
      connection.className = 'fleet-connection';
      connection.textContent = device.status === 'ready' ? '在线' : '离线';
      title.append(dot, name, connection);
      const route = document.createElement('div');
      route.className = 'fleet-route';
      const source = device.sources?.[0] || '*';
      const provider = source === '*' ? null : providerFor(source);
      const routeArrow = document.createElement('span');
      routeArrow.className = 'fleet-route-arrow';
      routeArrow.textContent = '→';
      const providerIcon = document.createElement('span');
      providerIcon.className = 'fleet-provider-icon';
      if (provider) renderProviderIcon(providerIcon, provider);
      else providerIcon.textContent = '∞';
      const select = document.createElement('select');
      select.className = 'fleet-route-select';
      select.setAttribute('aria-label', `设置 ${device.name} 对应的软件`);
      select.append(providerOptions(source));
      select.value = source;
      select.addEventListener('change', async () => {
        const selected = select.value;
        select.disabled = true;
        try {
          await window.agentLight.saveDevice({ ...device, sources: [selected] });
          const name = selected === '*' ? '所有软件' : providerFor(selected)?.name || selected;
          toast(`${device.name} → ${name}`);
          await refresh();
        } catch (error) {
          select.value = source;
          select.disabled = false;
          toast(error.message, true);
        }
      });
      route.append(routeArrow, providerIcon, select);
      const status = document.createElement('small');
      status.className = 'fleet-state-label';
      status.textContent = `当前 · ${remainingLabel(device)}`;
      copy.append(title, route, status);
      const lamp = document.createElement('div');
      lamp.className = 'mini-lamp';
      lamp.setAttribute('aria-hidden', 'true');
      lamp.append(...Array.from({ length: 10 }, () => document.createElement('i')));
      card.append(copy, lamp);
      return card;
    });
    if (hasOverflow) {
      const overflow = document.createElement('button');
      overflow.type = 'button';
      overflow.className = 'fleet-overflow';
      const count = document.createElement('strong');
      count.textContent = `+${enabled.length - visible.length}`;
      const label = document.createElement('span');
      label.textContent = '更多实体灯';
      const hint = document.createElement('small');
      hint.textContent = '前往设备管理';
      overflow.append(count, label, hint);
      overflow.addEventListener('click', () => openSettings('devices'));
      cards.push(overflow);
    }
    elements.lampFleet.replaceChildren(...cards);
  }

  function makeScreenshotFleet(next, count) {
    if (!screenshotMode || count <= 0) return next;
    const providers = (next.providers || []).filter((provider) => provider.enabled !== false);
    const colors = ['green', 'yellow', 'blue', 'red', 'off'];
    const now = Date.now();
    return {
      ...next,
      ble: { state: 'ready', name: `${count} 盏状态灯` },
      devices: Array.from({ length: count }, (_, index) => {
        const provider = providers[index % Math.max(1, providers.length)];
        const displayed = colors[index % colors.length];
        return {
          id: `preview-${index + 1}`,
          name: `状态灯 ${String.fromCharCode(65 + (index % 26))} · ${String(9600 + index).slice(0, 4)}`,
          enabled: true,
          status: index === count - 1 && count > 3 ? 'connecting' : 'ready',
          sources: [provider?.id || '*'],
          displayed,
          active: displayed === 'off' ? [] : [{ key: `preview-${index}`, state: displayed, expiresAt: now + (42 + index) * 1000 }],
        };
      }),
    };
  }

  function renderEvents(events) {
    if (!events?.length) {
      elements.eventLog.innerHTML = '<li class="empty">暂无事件</li>';
      return;
    }
    elements.eventLog.replaceChildren(...events.slice(0, 4).map((entry) => {
      const item = document.createElement('li');
      const time = document.createElement('time');
      time.dateTime = entry.at;
      time.textContent = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = entry.message;
      const detail = document.createElement('small');
      detail.textContent = entry.detail || entry.kind;
      copy.append(title, detail);
      item.append(time, copy);
      return item;
    }));
  }

  function providerIconSource(provider) {
    if (provider?.iconUrl) return provider.iconUrl;
    if (provider?.asset) return `../resources/providers/${provider.asset}`;
    return '';
  }

  function renderProviderIcon(container, provider) {
    container.style.setProperty('--provider-accent', provider?.accent || '#8aa0b3');
    const source = providerIconSource(provider);
    if (source) {
      const image = document.createElement('img');
      image.src = source;
      image.alt = '';
      image.addEventListener('error', () => { container.textContent = (provider?.short || provider?.name || '?').slice(0, 1).toUpperCase(); });
      container.replaceChildren(image);
    } else {
      container.textContent = (provider?.short || provider?.name || '?').slice(0, 1).toUpperCase();
    }
  }

  function renderAgentStrip(next = snapshot) {
    const enabled = (next?.providers || []).filter((provider) => provider.enabled !== false);
    const visible = enabled.filter((provider) => provider.pinned).slice(0, 3);
    const hiddenCount = enabled.length - visible.length;
    elements.agentStrip.style.setProperty('--agent-count', String(Math.max(1, visible.length + (hiddenCount > 0 ? 1 : 0))));
    const chips = visible.map((provider) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'agent-chip';
      chip.style.setProperty('--provider-accent', provider.accent);
      const icon = document.createElement('span');
      icon.className = 'provider-icon';
      renderProviderIcon(icon, provider);
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = provider.short || provider.name;
      const state = document.createElement('small');
      const adapter = next.adapters?.[provider.id];
      state.className = adapter?.installed ? 'ready' : 'error';
      state.textContent = adapter?.installed ? '已接入' : provider.tier === 'bridge' ? '事件桥' : '待接入';
      copy.append(name, state);
      chip.append(icon, copy);
      chip.addEventListener('click', () => {
        selectedDashboardProvider = provider.id;
        localStorage.setItem('codelight.dashboard-provider', provider.id);
        renderDashboard(next);
      });
      return chip;
    });
    if (hiddenCount > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'agent-chip more';
      more.textContent = `+${hiddenCount} Agent`;
      more.addEventListener('click', () => openSettings('providers'));
      chips.push(more);
    }
    elements.agentStrip.replaceChildren(...chips);
  }

  function renderFullEvents(events = snapshot?.events || []) {
    if (!events.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '暂无事件';
      elements.fullEventLog.replaceChildren(empty);
      return;
    }
    elements.fullEventLog.replaceChildren(...events.map((entry) => {
      const row = document.createElement('li');
      const time = document.createElement('time');
      time.dateTime = entry.at;
      time.textContent = new Date(entry.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = entry.message;
      const detail = document.createElement('small');
      detail.textContent = [entry.project, entry.detail].filter(Boolean).join(' · ') || entry.kind;
      copy.append(title, detail);
      const state = document.createElement('span');
      state.className = 'event-state-pill';
      state.textContent = entry.kind;
      row.append(time, copy, state);
      return row;
    }));
  }

  function selectProvider(id, isNew = false) {
    providerIsNew = isNew;
    selectedProviderId = id;
    const provider = isNew ? {
      id: '', name: '', short: '', accent: '#8aa0b3', icon: '', appPath: '', enabled: true, apps: [], tier: 'bridge',
    } : snapshot?.providers?.find((item) => item.id === id);
    if (!provider) return;
    elements.providerId.value = provider.id;
    elements.providerId.disabled = !isNew;
    elements.providerName.value = provider.name || '';
    elements.providerShort.value = provider.short || '';
    elements.providerAccent.value = provider.accent || '#8aa0b3';
    elements.providerIcon.value = provider.icon || '';
    elements.providerAppPath.value = provider.appPath || '';
    elements.providerEnabled.checked = provider.enabled !== false;
    elements.providerPinned.checked = provider.pinned === true;
    elements.providerEditorTitle.textContent = isNew ? '添加 Provider' : provider.name;
    elements.providerBridgeCommand.textContent = provider.id
      ? `事件桥：${provider.bridgeCommand || `$HOME/.agent-status-light/bin/agent-light-hook --emit ${provider.id} EVENT --session PROJECT`}`
      : '保存后即可使用通用事件桥';
    elements.deleteProvider.disabled = isNew;
    renderProviderIcon(elements.providerIconPreview, provider);
    renderProviderList();
  }

  function renderProviderList() {
    const providers = snapshot?.providers || [];
    elements.providerCount.textContent = `${providers.length} 个`;
    elements.providerList.replaceChildren(...providers.map((provider) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `provider-list-item${provider.id === selectedProviderId && !providerIsNew ? ' active' : ''}${provider.enabled ? ' enabled' : ''}`;
      button.style.setProperty('--provider-accent', provider.accent);
      const icon = document.createElement('span');
      icon.className = 'provider-mini-icon';
      renderProviderIcon(icon, provider);
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = provider.name;
      const id = document.createElement('small');
      id.textContent = provider.id;
      copy.append(name, id);
      const indicator = document.createElement('i');
      button.append(icon, copy, indicator);
      button.addEventListener('click', () => selectProvider(provider.id));
      return button;
    }));
    if (!selectedProviderId && providers.length && !providerIsNew) selectProvider(providers[0].id);
  }

  function providerOptions(selected) {
    const fragment = document.createDocumentFragment();
    const all = document.createElement('option');
    all.value = '*';
    all.textContent = '所有 Provider（共享灯）';
    fragment.append(all);
    for (const provider of snapshot?.providers || []) {
      if (!provider.enabled) continue;
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name;
      fragment.append(option);
    }
    fragment.querySelector?.(`option[value="${CSS.escape(selected || '*')}"]`)?.setAttribute('selected', '');
    return fragment;
  }

  function renderDeviceManager() {
    const devices = snapshot?.devices || [];
    if (!devices.length) {
      const empty = document.createElement('div');
      empty.className = 'device-manager-empty';
      empty.textContent = '尚未绑定跑马灯，点击“扫描新设备”开始。';
      elements.deviceManagerList.replaceChildren(empty);
      return;
    }
    elements.deviceManagerList.replaceChildren(...devices.map((device) => {
      const row = document.createElement('div');
      row.className = 'device-manager-item';
      const identity = document.createElement('div');
      identity.className = `device-identity ${device.status === 'ready' ? 'ready' : ''}`;
      const dot = document.createElement('i');
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = `${device.name} · ${device.status === 'ready' ? '已连接' : device.enabled === false ? '已释放' : '未连接'}`;
      const id = document.createElement('small');
      id.textContent = device.enabled === false
        ? '跨电脑接管：长按 POWER 2 秒关机，再长按 2 秒开机'
        : device.id;
      copy.append(name, id);
      identity.append(dot, copy);
      const route = document.createElement('div');
      route.className = 'device-route';
      const label = document.createElement('label');
      label.textContent = '绑定 Provider';
      const select = document.createElement('select');
      select.append(providerOptions(device.sources?.[0] || '*'));
      select.value = device.sources?.[0] || '*';
      select.addEventListener('change', async () => {
        try {
          await window.agentLight.saveDevice({ ...device, sources: [select.value] });
          toast(`${device.name} 已绑定 ${select.options[select.selectedIndex].textContent}`);
          await refresh();
        } catch (error) { toast(error.message, true); }
      });
      route.append(label, select);
      const actions = document.createElement('div');
      actions.className = 'device-actions';
      const test = document.createElement('button');
      test.type = 'button';
      test.className = 'secondary-button compact';
      test.textContent = '测试';
      test.disabled = device.enabled === false;
      test.addEventListener('click', () => window.agentLight.testDevice(device.id, 'green').then(() => toast(`${device.name} 测试已发送`)).catch((error) => toast(error.message, true)));
      const release = document.createElement('button');
      release.type = 'button';
      release.className = device.enabled === false ? 'primary-button compact' : 'secondary-button compact';
      release.textContent = device.enabled === false ? '重新连接' : '释放蓝牙';
      release.addEventListener('click', async () => {
        try {
          if (device.enabled === false) {
            await window.agentLight.saveDevice({ ...device, enabled: true });
            toast(`${device.name} 正在重新连接 Mac`);
          } else {
            await window.agentLight.releaseDevice(device.id);
            bleControllers.get(device.id)?.close();
            bleControllers.delete(device.id);
            toast(`${device.name} 已释放；重启灯后可由另一台电脑搜索`);
          }
          await refresh();
        } catch (error) { toast(error.message, true); }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger-button';
      remove.textContent = '删除记录';
      remove.disabled = devices.length <= 1;
      remove.addEventListener('click', async () => {
        try { await window.agentLight.removeDevice(device.id); await refresh(); }
        catch (error) { toast(error.message, true); }
      });
      actions.append(test, release, remove);
      row.append(identity, route, actions);
      return row;
    }));
  }

  function renderSettings() {
    if (!snapshot) return;
    elements.durationSelect.value = String(snapshot.settings?.statusDurationSeconds ?? 60);
    elements.notificationEnabled.checked = snapshot.settings?.notifications?.enabled !== false;
    elements.notificationSuccess.checked = snapshot.settings?.notifications?.success !== false;
    elements.notificationAttention.checked = snapshot.settings?.notifications?.attention !== false;
    elements.notificationError.checked = snapshot.settings?.notifications?.error !== false;
    renderProviderList();
    renderDeviceManager();
    renderFullEvents();
  }

  function openSettings(page = 'general') {
    elements.settingsModal.hidden = false;
    document.querySelector(`[data-settings-tab="${page}"]`)?.click();
    renderSettings();
  }

  function closeSettings() {
    elements.settingsModal.hidden = true;
  }

  function formatReset(timestamp) {
    if (!timestamp) return '重置时间未知';
    const delta = timestamp - Date.now();
    if (delta <= 0) return '即将重置';
    const hours = Math.floor(delta / 3_600_000);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} 天 ${hours % 24} 小时后`;
    if (hours > 0) return `${hours} 小时后`;
    return `${Math.max(1, Math.ceil(delta / 60_000))} 分钟后`;
  }

  function compactNumber(value) {
    return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
  }

  function renderQuota(quota, provider) {
    const value = quota || { status: 'loading', lanes: [] };
    const loading = ['loading', 'refreshing'].includes(value.status);
    elements.refreshQuota.classList.toggle('loading', loading);
    elements.refreshQuota.disabled = loading;
    elements.quotaPlan.textContent = value.plan || '—';

    if (value.lanes?.length) {
      elements.quotaLanes.replaceChildren(...value.lanes.map((lane) => {
        const row = document.createElement('div');
        row.className = `quota-lane${lane.severity === 'critical' ? ' critical' : ''}`;
        const label = document.createElement('div');
        label.className = 'quota-lane-label';
        const title = document.createElement('strong');
        title.textContent = lane.label;
        const reset = document.createElement('small');
        reset.textContent = lane.resetLabel || formatReset(lane.resetsAt);
        label.append(title, reset);
        const track = document.createElement('div');
        track.className = 'quota-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', `${lane.label}剩余额度`);
        track.setAttribute('aria-valuenow', String(lane.remainingPercent));
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        const fill = document.createElement('span');
        fill.style.setProperty('--remaining', `${lane.remainingPercent}%`);
        track.append(fill);
        const percent = document.createElement('div');
        percent.className = 'quota-value';
        const number = document.createElement('strong');
        number.textContent = `${lane.remainingPercent}%`;
        const suffix = document.createElement('small');
        suffix.textContent = '剩余';
        percent.append(number, suffix);
        row.append(label, track, percent);
        return row;
      }));
    } else if (value.stats?.length) {
      elements.quotaLanes.replaceChildren(...value.stats.map((stat) => {
        const card = document.createElement('div');
        card.className = 'quota-stat';
        const label = document.createElement('span');
        label.textContent = stat.label;
        const number = document.createElement('strong');
        number.textContent = stat.kind === 'tokens' ? compactNumber(stat.value) : String(stat.value);
        const suffix = document.createElement('small');
        suffix.textContent = stat.kind === 'tokens' ? 'Tokens' : stat.suffix || '';
        card.append(label, number, suffix);
        return card;
      }));
    } else if (value.statusBoard) {
      elements.quotaLanes.replaceChildren(...value.statusBoard.map((stat) => {
        const card = document.createElement('div');
        card.className = 'quota-stat status-stat';
        const label = document.createElement('span');
        label.textContent = stat.label;
        const number = document.createElement('strong');
        number.textContent = stat.value;
        const suffix = document.createElement('small');
        suffix.textContent = stat.detail || '';
        card.append(label, number, suffix);
        return card;
      }));
    } else {
      const message = document.createElement('div');
      if (['error', 'unavailable'].includes(value.status)) {
        message.className = 'quota-error';
        message.textContent = value.error || `暂时无法读取 ${provider?.short || 'Agent'} 数据`;
      } else {
        message.className = 'quota-loading';
        message.append(document.createElement('span'), `正在读取 ${provider?.short || 'Agent'} 数据`);
      }
      elements.quotaLanes.replaceChildren(message);
    }
    elements.quotaCredits.textContent = value.source || (value.resetCredits > 0 ? `可用重置 ${value.resetCredits} 次` : '本地状态数据');
    elements.quotaUpdated.textContent = value.updatedAt
      ? `${value.status === 'stale' ? '缓存 · ' : ''}${new Date(value.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 更新`
      : '尚未更新';
  }

  function genericProviderDashboard(next, provider) {
    const bound = (next.devices || []).filter((device) => device.sources?.includes('*') || device.sources?.includes(provider.id));
    const adapter = next.adapters?.[provider.id];
    const recent = (next.events || []).find((event) => event.source === provider.id || String(event.message || '').toLowerCase().startsWith(provider.short.toLowerCase()));
    return {
      status: 'ready', plan: String(provider.tier || 'bridge').toUpperCase(), source: 'CodeLight 实时状态', updatedAt: Date.now(),
      statusBoard: [
        { label: '事件接入', value: adapter?.installed ? '已接入' : provider.tier === 'bridge' ? '事件桥' : '待配置', detail: provider.tier || 'bridge' },
        { label: '绑定实体灯', value: `${bound.length} 盏`, detail: bound.length ? bound.map((device) => device.name).slice(0, 2).join('、') : '尚未绑定' },
        { label: '最近事件', value: recent ? stateLabels[recent.kind] || recent.kind : '暂无', detail: recent?.project || recent?.detail || '等待 Agent 事件' },
      ],
    };
  }

  function renderDashboard(next = snapshot) {
    const enabled = (next?.providers || []).filter((provider) => provider.enabled !== false);
    if (!enabled.some((provider) => provider.id === selectedDashboardProvider)) selectedDashboardProvider = enabled[0]?.id || 'codex';
    const provider = enabled.find((item) => item.id === selectedDashboardProvider) || providerFor(selectedDashboardProvider);
    const preferredIds = ['claude', 'codex'];
    const quickProviders = preferredIds.map((id) => enabled.find((item) => item.id === id)).filter(Boolean);
    elements.quotaProviderTabs.replaceChildren(...quickProviders.map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `quota-provider-tab${item.id === selectedDashboardProvider ? ' active' : ''}`;
      const icon = document.createElement('span');
      icon.className = 'quota-tab-icon';
      renderProviderIcon(icon, item);
      const label = document.createElement('span');
      label.textContent = item.short || item.name;
      button.append(icon, label);
      button.addEventListener('click', () => {
        selectedDashboardProvider = item.id;
        localStorage.setItem('codelight.dashboard-provider', item.id);
        renderDashboard(next);
      });
      return button;
    }));
    const quickIds = new Set(quickProviders.map((item) => item.id));
    const otherProviders = enabled.filter((item) => !quickIds.has(item.id));
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `其他 ${otherProviders.length}`;
    placeholder.selected = quickIds.has(selectedDashboardProvider);
    elements.quotaProviderSelect.replaceChildren(placeholder, ...otherProviders.map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      option.selected = item.id === selectedDashboardProvider;
      return option;
    }));
    elements.quotaProviderName.textContent = provider?.name || 'Agent';
    renderProviderIcon(elements.quotaProviderIcon, provider);
    const providerUsage = next?.providerUsage?.[selectedDashboardProvider];
    const usage = providerUsage && (providerUsage.lanes?.length || providerUsage.stats?.length || providerUsage.status !== 'unavailable')
      ? providerUsage
      : genericProviderDashboard(next, provider);
    renderQuota(usage, provider);
  }

  function renderSnapshot(next) {
    next = makeScreenshotFleet(next, screenshotFleetCount);
    snapshot = next;
    elements.backendMode.textContent = next.platform === 'darwin' ? '蓝牙后台' : '蓝牙连接';
    elements.footerVersion.textContent = `CodeLight v${next.version}`;
    setConnection(next.ble);
    updateConnectionGuard(next);
    if (!document.activeElement?.classList?.contains('fleet-route-select')) renderFleet(next.devices || []);
    renderAgentStrip(next);
    elements.chargerToggle.checked = Boolean(next.chargerSilence);
    elements.chargerBadge.textContent = next.chargerSilence ? '充电灯已隐藏' : '充电灯显示中';
    elements.chargerBadge.style.color = next.chargerSilence ? 'var(--green)' : 'var(--yellow)';
    const enabledProviders = (next.providers || []).filter((provider) => provider.enabled !== false);
    const installedAdapters = Object.values(next.adapters || {}).filter((adapter) => adapter.installed).length;
    elements.hookState.textContent = `${enabledProviders.length} 个 Provider · ${installedAdapters} 个适配器已接入`;
    renderDashboard(next);
    renderEvents(next.events);
    syncWindowsBleControllers(next);
    if (!elements.settingsModal.hidden) renderSettings();
  }

  async function refresh() {
    try { renderSnapshot(await window.agentLight.getState()); }
    catch (error) { toast(`读取状态失败：${error.message}`, true); }
  }

  async function requestNotificationPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') return Notification.permission;
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'denied') toast('通知权限未开启，可在系统设置中允许 CodeLight 通知', true);
      return permission;
    } catch (error) {
      console.warn('Notification permission request failed', error);
      return 'unsupported';
    }
  }

  async function command(value, successMessage) {
    try {
      const response = await window.agentLight.command(value);
      if (response.startsWith?.('ERR')) throw new Error(response);
      if (successMessage) toast(successMessage);
      await refresh();
      return response;
    } catch (error) {
      toast(error.message || String(error), true);
      throw error;
    }
  }

  async function autoRouteDevices() {
    const devices = (snapshot?.devices || []).filter((device) => device.enabled !== false);
    const enabledProviders = (snapshot?.providers || []).filter((provider) => provider.enabled !== false);
    const providers = [
      ...enabledProviders.filter((provider) => provider.pinned),
      ...enabledProviders.filter((provider) => !provider.pinned),
    ];
    if (!devices.length) return toast('请先连接至少一盏状态灯', true);
    if (providers.length < devices.length) return toast(`只有 ${providers.length} 个已启用软件，无法为 ${devices.length} 盏灯一一绑定`, true);
    elements.autoRouteButton.disabled = true;
    try {
      for (let index = 0; index < devices.length; index += 1) {
        await window.agentLight.saveDevice({ ...devices[index], sources: [providers[index].id] });
      }
      toast(devices.map((device, index) => `${device.name} → ${providers[index].short || providers[index].name}`).join('；'));
      await refresh();
    } catch (error) {
      toast(`一一绑定失败：${error.message}`, true);
    } finally {
      elements.autoRouteButton.disabled = false;
    }
  }

  async function waitForConnection(deviceId = '') {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const next = await window.agentLight.getState();
      renderSnapshot(next);
      if (deviceId) {
        if (next.devices?.find((device) => device.id === deviceId)?.status === 'ready') return true;
      } else if (snapshotConnected(next)) return true;
    }
    return false;
  }

  async function bindMacDevice(device, { button = null, closeOnSuccess = true } = {}) {
    const previous = snapshot?.devices?.find((item) => item.id === device.id);
    elements.connectionModalMessage.textContent = `正在通过蓝牙连接 ${device.name || 'JTX-RGB'}…`;
    if (button) {
      button.disabled = true;
      button.textContent = '连接中…';
    }
    try {
      const claimed = await window.agentLight.claimDevice({
        id: device.id,
        name: device.name || 'JTX-RGB',
        enabled: true,
        ...(previous?.sources ? { sources: previous.sources } : {}),
      });
      if (await waitForConnection(device.id)) {
        const provider = providerFor(claimed.source);
        toast(`${device.name || 'JTX-RGB'} 已连接${provider ? `并绑定 ${provider.name}` : ''}`);
        if (closeOnSuccess) hideConnectionModal(false);
        return true;
      }
      elements.connectionModalMessage.textContent = '设备已保存，但暂时没有连上。请确认灯已开机、未被手机 Colorful Lights 占用，然后重试。';
      return false;
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = device.configured ? '重新连接' : '连接';
      }
    }
  }

  function bluetoothSignal(rssi) {
    const value = Number(rssi);
    if (!Number.isFinite(value) || value === 0) return '蓝牙设备';
    if (value >= -60) return `信号强 · ${value} dBm`;
    if (value >= -75) return `信号良好 · ${value} dBm`;
    return `信号较弱 · ${value} dBm`;
  }

  function renderScanProgress(target, text = '正在搜索附近的蓝牙跑马灯…') {
    const state = document.createElement('div');
    state.className = 'bluetooth-scan-state';
    state.setAttribute('role', 'status');
    const radar = document.createElement('span');
    radar.className = 'bluetooth-scan-radar';
    const copy = document.createElement('span');
    copy.textContent = text;
    state.append(radar, copy);
    target.replaceChildren(state);
  }

  function windowsBluetoothError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '').trim();
    if (name === 'NotFoundError' || /cancel|cancelled|canceled/i.test(message)) {
      return '没有选择设备。请确认 Windows 蓝牙已打开，然后重新搜索并点击 JTX-RGB。';
    }
    if (name === 'SecurityError' || /permission|denied|not allowed/i.test(message)) {
      return '蓝牙权限被拒绝。请在 Windows 隐私设置中允许 CodeLight 使用蓝牙。';
    }
    if (name === 'NetworkError' || /gatt|connect|disconnected/i.test(message)) {
      return '控制通道连接失败。请关闭手机 Colorful Lights、让灯靠近电脑后重试。';
    }
    return message || '蓝牙连接失败';
  }

  function renderWindowsBluetoothCandidates({ devices = [] } = {}) {
    if (snapshot?.platform !== 'win32' || !windowsBluetoothSelecting) return;
    const target = windowsBluetoothTarget === 'settings' ? elements.deviceScanResults : elements.connectionDeviceList;
    if (!devices.length) {
      renderScanProgress(target, '正在搜索 JTX-RGB（兼容大小写名称）…');
      return;
    }
    const rows = devices.map((device) => {
      const configured = snapshot?.devices?.find((item) => item.id === device.id);
      const row = document.createElement('div');
      row.className = windowsBluetoothTarget === 'settings' ? 'scan-result' : 'connection-device-item';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = device.name || 'JTX-RGB';
      const id = document.createElement('small');
      id.textContent = `蓝牙 ID · ${String(device.id).slice(-8)}${configured ? ` · ${configured.name}` : ''}`;
      copy.append(name, id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'primary-button compact';
      const alreadyConnected = configured?.status === 'ready';
      button.textContent = alreadyConnected ? '已连接' : configured ? '重新连接' : '连接';
      button.disabled = alreadyConnected;
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = '连接中…';
        if (windowsBluetoothTarget === 'modal') elements.connectionModalMessage.textContent = `正在建立 ${device.name || 'JTX-RGB'} 的 FFF0/FFF3 控制通道…`;
        try {
          await window.agentLight.selectBluetoothDevice(device.id);
          renderScanProgress(target, '设备已选择，正在建立蓝牙控制通道…');
        } catch (error) {
          button.disabled = false;
          button.textContent = configured ? '重新连接' : '连接';
          toast(error.message, true);
        }
      });
      row.append(copy, button);
      return row;
    });
    target.replaceChildren(...rows);
    if (windowsBluetoothTarget === 'modal') {
      elements.connectionModalMessage.textContent = `发现 ${devices.length} 个兼容跑马灯，请点击对应设备右侧的“连接”。`;
    }
  }

  function renderDiscoveredDevices(devices) {
    elements.connectionDeviceList.replaceChildren(...devices.map((device) => {
      const row = document.createElement('div');
      row.className = 'connection-device-item';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = device.name || 'JTX-RGB';
      const id = document.createElement('small');
      id.textContent = `${bluetoothSignal(device.rssi)} · ${String(device.id).slice(-8)}`;
      copy.append(name, id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'primary-button compact';
      button.textContent = device.configured ? '重新连接' : '连接';
      button.addEventListener('click', () => bindMacDevice(device, { button }).catch((error) => {
        elements.connectionModalMessage.textContent = `连接失败：${error.message}`;
      }));
      row.append(copy, button);
      return row;
    }));
  }

  async function connect() {
    if (connectionBusy) return;
    connectionBusy = true;
    elements.connectionNow.disabled = true;
    if (snapshot?.platform === 'win32') {
      try {
        windowsBluetoothTarget = 'modal';
        windowsBluetoothSelecting = true;
        elements.connectionModalMessage.textContent = '正在搜索附近的 JTX-RGB，请在下方列表中选择。';
        renderScanProgress(elements.connectionDeviceList, '正在搜索 Windows 蓝牙设备…');
        await connectWindowsDevice();
      } catch (error) {
        elements.connectionModalMessage.textContent = `蓝牙连接失败：${windowsBluetoothError(error)}`;
      } finally {
        windowsBluetoothSelecting = false;
      }
    } else {
      try {
        elements.connectionModalMessage.textContent = '正在搜索附近的蓝牙跑马灯，请稍候…';
        renderScanProgress(elements.connectionDeviceList);
        const devices = await window.agentLight.scanDevices();
        if (!devices.length) {
          elements.connectionModalMessage.textContent = '没有发现 JTX-RGB。请打开灯、关闭手机 Colorful Lights 的连接后重试。';
          elements.connectionDeviceList.replaceChildren();
        } else {
          elements.connectionModalMessage.textContent = `发现 ${devices.length} 个蓝牙设备，请点击对应设备右侧的“连接”。`;
          renderDiscoveredDevices(devices);
        }
      } catch (error) {
        elements.connectionModalMessage.textContent = `扫描失败：${error.message}`;
      }
    }
    connectionBusy = false;
    elements.connectionNow.disabled = false;
    elements.connectionNow.textContent = '重新搜索';
  }

  function createWindowsController(deviceId = '') {
    const controller = new window.JTXBleController({
      deviceId,
      onStatus: (status) => {
        setConnection(status);
        if (status?.state === 'disconnected') showConnectionModal({ dropped: true, devices: status.name || 'JTX-RGB' });
        setTimeout(refresh, 120);
      },
      onLog: (message, detail) => console.info(message, detail),
    });
    controller.setChargerSilence(snapshot?.chargerSilence !== false);
    return controller;
  }

  async function connectWindowsDevice() {
    const unready = (snapshot?.devices || []).find((device) => device.status !== 'ready');
    let controller = unready ? bleControllers.get(unready.id) : null;
    if (!controller) controller = createWindowsController(unready?.id || '');
    await controller.connect(true, true);
    const descriptor = controller.descriptor();
    if (!descriptor?.id) throw new Error('系统未返回蓝牙设备 ID');
    const previous = snapshot?.devices?.find((device) => device.id === descriptor.id);
    const claimed = await window.agentLight.claimDevice({
      id: descriptor.id,
      name: descriptor.name,
      enabled: true,
      ...((previous?.sources || unready?.sources) ? { sources: previous?.sources || unready?.sources } : {}),
    });
    if (unready?.id && unready.id !== descriptor.id) bleControllers.delete(unready.id);
    bleControllers.set(descriptor.id, controller);
    if (!windowsAdaptersInstalled) {
      const result = await window.agentLight.installHooks();
      windowsAdaptersInstalled = result?.ok !== false;
      if (result?.ok === false) toast(result.message, true);
    }
    await refresh();
    const provider = providerFor(claimed.source);
    if (claimed.created) {
      const reason = claimed.matchedBy === 'installed-tool' ? '检测到本机软件' : '按灯具连接顺序';
      toast(`${descriptor.name} 已自动绑定 ${provider?.name || claimed.source} · ${reason}`);
    }
    if (snapshotConnected()) hideConnectionModal(false);
  }

  function syncWindowsBleControllers(next = snapshot) {
    if (next?.platform !== 'win32') return;
    const wanted = new Set((next.devices || []).filter((device) => device.enabled !== false).map((device) => device.id));
    for (const [id, controller] of bleControllers) {
      if (!wanted.has(id)) { controller.close(); bleControllers.delete(id); }
    }
    for (const device of (next.devices || []).filter((item) => item.enabled !== false)) {
      if (bleControllers.has(device.id)) continue;
      const controller = createWindowsController(device.id);
      bleControllers.set(device.id, controller);
      controller.restore(device.id).catch(() => {});
    }
  }

  function setupWindowsBle() {
    if (snapshot?.platform !== 'win32') return;
    syncWindowsBleControllers();
    window.agentLight.onBluetoothCandidates(renderWindowsBluetoothCandidates);
    window.agentLight.onBluetoothSelectionFinished(({ reason }) => {
      if (reason === 'timeout' && windowsBluetoothSelecting) {
        const target = windowsBluetoothTarget === 'settings' ? elements.deviceScanResults : elements.connectionDeviceList;
        target.textContent = '30 秒内没有发现或选择 JTX-RGB，请确认 Windows 蓝牙已打开后重试。';
      }
    });
    window.agentLight.onDeviceDisplay((event) => {
      const device = snapshot?.devices?.find((item) => item.id === event.deviceId);
      if (device) {
        device.displayed = event.state;
        device.active = event.snapshot?.active || device.active;
      }
      renderFleet(snapshot?.devices || [], event.deviceId);
      bleControllers.get(event.deviceId)?.display(event.state, event.state !== 'off').catch((error) => toast(error.message, true));
    });
    window.agentLight.onChargerMode(({ silence }) => {
      for (const controller of bleControllers.values()) controller.setChargerSilence(silence);
      elements.chargerToggle.checked = silence;
    });
  }

  function serializableProviders() {
    return (snapshot?.providers || []).map(({ iconUrl: _iconUrl, ...provider }) => provider);
  }

  function renderDeviceScanResults(devices) {
    elements.deviceScanResults.replaceChildren(...devices.map((device) => {
      const row = document.createElement('div');
      row.className = 'scan-result';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = device.name || 'JTX-RGB';
      const id = document.createElement('small');
      id.textContent = `${bluetoothSignal(device.rssi)} · ${String(device.id).slice(-8)}`;
      copy.append(name, id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'primary-button compact';
      button.textContent = device.configured ? '重新连接' : '连接';
      button.addEventListener('click', async () => {
        try {
          const connected = await bindMacDevice(device, { button, closeOnSuccess: false });
          if (!connected) toast('设备已保存，蓝牙仍在重连', true);
          await refresh();
        } catch (error) { toast(error.message, true); }
      });
      row.append(copy, button);
      return row;
    }));
  }

  document.querySelectorAll('.settings-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.settings-page').forEach((page) => {
        const active = page.dataset.settingsPage === button.dataset.settingsTab;
        page.hidden = !active;
        page.classList.toggle('active', active);
      });
    });
  });

  elements.settingsButton.addEventListener('click', () => openSettings('general'));
  elements.settingsClose.addEventListener('click', closeSettings);
  elements.saveGeneral.addEventListener('click', async () => {
    try {
      await window.agentLight.updateSettings({
        statusDurationSeconds: Number(elements.durationSelect.value),
        notifications: {
          enabled: elements.notificationEnabled.checked,
          success: elements.notificationSuccess.checked,
          attention: elements.notificationAttention.checked,
          error: elements.notificationError.checked,
        },
      });
      if (elements.notificationEnabled.checked) await requestNotificationPermission();
      toast('通用设置已保存');
      await refresh();
    } catch (error) { toast(error.message, true); }
  });

  elements.addProvider.addEventListener('click', () => selectProvider('', true));
  elements.providerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = elements.providerId.value.trim().toLowerCase().replace(/\s+/g, '-');
    const name = elements.providerName.value.trim();
    if (!/^[a-z0-9._-]{2,48}$/.test(id)) return toast('Provider ID 只能包含字母、数字、点、横线或下划线', true);
    if (!name) return toast('请填写 Provider 名称', true);
    const providers = serializableProviders();
    const index = providers.findIndex((provider) => provider.id === selectedProviderId);
    if (providerIsNew && providers.some((provider) => provider.id === id)) return toast('Provider ID 已存在', true);
    const previous = index >= 0 ? providers[index] : {};
    const provider = {
      ...previous,
      id,
      name,
      short: elements.providerShort.value.trim() || name,
      accent: elements.providerAccent.value,
      icon: elements.providerIcon.value.trim(),
      appPath: elements.providerAppPath.value.trim(),
      enabled: elements.providerEnabled.checked,
      pinned: elements.providerPinned.checked,
      apps: previous.apps || [],
      tier: previous.tier || 'bridge',
      builtIn: previous.builtIn === true,
    };
    if (index >= 0) providers[index] = provider;
    else providers.push(provider);
    try {
      await window.agentLight.updateSettings({ providers });
      selectedProviderId = id;
      providerIsNew = false;
      toast(`${name} 已保存`);
      await refresh();
      selectProvider(id);
    } catch (error) { toast(error.message, true); }
  });

  elements.deleteProvider.addEventListener('click', async () => {
    if (providerIsNew || !selectedProviderId) return;
    const providers = serializableProviders().filter((provider) => provider.id !== selectedProviderId);
    if (!providers.length) return toast('至少保留一个 Provider', true);
    try {
      await window.agentLight.updateSettings({ providers });
      for (const device of snapshot.devices || []) {
        if (device.sources?.includes(selectedProviderId)) await window.agentLight.saveDevice({ ...device, sources: ['*'] });
      }
      selectedProviderId = providers[0].id;
      providerIsNew = false;
      toast('Provider 已删除');
      await refresh();
      selectProvider(selectedProviderId);
    } catch (error) { toast(error.message, true); }
  });

  elements.chooseProviderIcon.addEventListener('click', async () => {
    const selected = await window.agentLight.chooseProviderIcon();
    if (selected) elements.providerIcon.value = selected;
  });
  elements.chooseProviderApp.addEventListener('click', async () => {
    const selected = await window.agentLight.chooseProviderApp();
    if (selected) elements.providerAppPath.value = selected;
  });
  elements.testProviderNotification.addEventListener('click', () => {
    const id = providerIsNew ? elements.providerId.value.trim() : selectedProviderId;
    if (id) window.agentLight.testNotification(id);
  });
  elements.scanDevices.addEventListener('click', async () => {
    elements.scanDevices.disabled = true;
    elements.scanDevices.textContent = '正在搜索…';
    renderScanProgress(elements.deviceScanResults);
    try {
      if (snapshot?.platform === 'win32') {
        windowsBluetoothTarget = 'settings';
        windowsBluetoothSelecting = true;
        await connectWindowsDevice();
        elements.deviceScanResults.textContent = '蓝牙设备已连接。';
      } else {
        const devices = await window.agentLight.scanDevices();
        if (!devices.length) elements.deviceScanResults.textContent = '没有发现 JTX-RGB，请确认设备已开机且没有被手机占用。';
        else renderDeviceScanResults(devices);
      }
    } catch (error) { toast(snapshot?.platform === 'win32' ? windowsBluetoothError(error) : error.message, true); }
    finally {
      windowsBluetoothSelecting = false;
      elements.scanDevices.disabled = false;
      elements.scanDevices.textContent = '重新搜索';
    }
  });
  elements.refreshFullEvents.addEventListener('click', refresh);

  document.querySelectorAll('.status-card').forEach((button) => {
    button.addEventListener('click', async () => {
      const color = button.dataset.color;
      await command(`demo ${color}`, `${stateLabels[color]}测试已发送`).catch(() => {});
    });
  });
  elements.connectButton.addEventListener('click', () => {
    if (snapshotConnected(snapshot) || snapshot?.ble?.state === 'released') {
      openSettings('devices');
      return;
    }
    showConnectionModal();
    connect();
  });
  elements.autoRouteButton.addEventListener('click', autoRouteDevices);
  elements.connectionNow.addEventListener('click', connect);
  elements.connectionLater.addEventListener('click', () => {
    if (snapshot?.platform === 'win32' && windowsBluetoothSelecting) window.agentLight.cancelBluetoothSelection().catch(() => {});
    hideConnectionModal(true);
  });
  elements.offButton.addEventListener('click', () => command('clear-all', '灯光已熄灭').catch(() => {}));
  elements.hideWindow.addEventListener('click', () => window.agentLight.hideWindow());
  elements.refreshButton.addEventListener('click', refresh);
  elements.refreshQuota.addEventListener('click', async () => {
    try {
      elements.refreshQuota.classList.add('loading');
      elements.refreshQuota.disabled = true;
      await window.agentLight.refreshQuota();
      await refresh();
    } catch (error) {
      toast(error.message || String(error), true);
    } finally {
      elements.refreshQuota.classList.remove('loading');
      elements.refreshQuota.disabled = false;
    }
  });
  elements.quotaProviderSelect.addEventListener('change', () => {
    if (!elements.quotaProviderSelect.value) return;
    selectedDashboardProvider = elements.quotaProviderSelect.value;
    localStorage.setItem('codelight.dashboard-provider', selectedDashboardProvider);
    renderDashboard(snapshot);
  });
  elements.chargerToggle.addEventListener('change', () => command(`charger-silence ${elements.chargerToggle.checked ? 'on' : 'off'}`, elements.chargerToggle.checked ? '充电灯已隐藏' : '已恢复固件充电显示').catch(() => { elements.chargerToggle.checked = !elements.chargerToggle.checked; }));
  elements.previewCharge.addEventListener('click', async () => {
    await command('charger-status 10', '充电状态显示 10 秒').catch(() => {});
    clearInterval(chargerPreviewTimer);
    let remaining = 10;
    elements.previewCharge.disabled = true;
    elements.previewCharge.textContent = `剩余 ${remaining} 秒`;
    chargerPreviewTimer = setInterval(() => {
      remaining -= 1;
      elements.previewCharge.textContent = remaining > 0 ? `剩余 ${remaining} 秒` : '显示 10 秒';
      if (remaining <= 0) { clearInterval(chargerPreviewTimer); elements.previewCharge.disabled = false; refresh(); }
    }, 1000);
  });
  elements.installHooks.addEventListener('click', async () => {
    try { const result = await window.agentLight.installHooks(); toast(result.message, !result.ok); await refresh(); }
    catch (error) { toast(error.message, true); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const color = { g: 'green', y: 'yellow', b: 'blue', r: 'red' }[event.key.toLowerCase()];
    if (color) document.querySelector(`[data-color="${color}"]`)?.click();
    if (event.key === 'Escape' && !elements.settingsModal.hidden) closeSettings();
    else if (event.key === 'Escape' && !elements.connectionModal.hidden) hideConnectionModal(true);
    else if (event.key === 'Escape') elements.offButton.click();
  });
  window.addEventListener('beforeunload', () => { for (const controller of bleControllers.values()) controller.close(); });
  window.agentLight.onSnapshot(renderSnapshot);
  window.agentLight.onConnectionRequired((event) => showConnectionModal(event));

  requestNotificationPermission();
  refresh().then(() => {
    setupWindowsBle();
    const requestedPage = new URLSearchParams(location.search).get('settings');
    if (requestedPage) openSettings(requestedPage);
  });
})();
