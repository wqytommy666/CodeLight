'use strict';

const { PROVIDERS, normalizeProviderId } = require('./providers');

const DEFAULT_NOTIFICATIONS = Object.freeze({ enabled: true, success: true, attention: true, error: true });
const DEFAULT_DURATION_SECONDS = 60;
const ALLOWED_DURATIONS = new Set([0, 10, 30, 60, 120, 300]);

function normalizeProvider(provider, index = 0) {
  const requestedId = normalizeProviderId(provider?.id || `provider-${index + 1}`);
  const fallback = PROVIDERS.find((item) => item.id === requestedId) || {};
  const id = normalizeProviderId(provider?.id || fallback.id || `provider-${index + 1}`)
    .replace(/[^a-z0-9._-]/g, '-').slice(0, 48);
  const apps = Array.isArray(provider?.apps) ? provider.apps : fallback.apps;
  return {
    id,
    name: String(provider?.name || fallback.name || id).trim().slice(0, 64),
    short: String(provider?.short || provider?.name || fallback.short || id).trim().slice(0, 24),
    accent: /^#[0-9a-f]{6}$/i.test(provider?.accent || '') ? provider.accent : fallback.accent || '#8aa0b3',
    tier: String(provider?.tier || fallback.tier || 'bridge').slice(0, 16),
    apps: [...new Set((apps || []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 8),
    appPath: String(provider?.appPath || '').trim().slice(0, 1024),
    icon: String(provider?.icon || '').trim().slice(0, 2048),
    asset: String(fallback.asset || provider?.asset || '').trim().slice(0, 128),
    enabled: provider?.enabled !== false,
    pinned: provider?.pinned === undefined ? fallback.pinned === true : provider.pinned === true,
    builtIn: provider?.builtIn === true || Boolean(fallback.id && fallback.id === id),
  };
}

function normalizeDevice(device, index = 0) {
  const id = String(device?.id || '').trim();
  const sources = Array.isArray(device?.sources) && device.sources.length
    ? [...new Set(device.sources.map((source) => source === '*' ? '*' : normalizeProviderId(source)))]
    : ['*'];
  const ordinal = index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
  const bluetoothCode = id.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || String(index + 1).padStart(2, '0');
  const requestedName = String(device?.name || '').trim();
  const genericName = !requestedName || /^JTX-RGB(?:\s+[A-Z0-9]+)?$/i.test(requestedName);
  return {
    id,
    name: (genericName ? `状态灯 ${ordinal} · ${bluetoothCode}` : requestedName).slice(0, 48),
    port: Number.isInteger(Number(device?.port)) ? Math.max(48733, Math.min(48832, Number(device.port))) : 48733 + index,
    enabled: device?.enabled !== false,
    sources,
  };
}

function normalizeSettings(input = {}, primaryId = '') {
  const devices = Array.isArray(input.devices) ? input.devices.map(normalizeDevice).filter((device) => device.id) : [];
  if (!devices.length && primaryId) devices.push(normalizeDevice({ id: primaryId, port: 48733, sources: ['*'] }));
  const usedPorts = new Set();
  devices.forEach((device, index) => {
    if (usedPorts.has(device.port)) device.port = 48733 + index;
    usedPorts.add(device.port);
  });
  const notifications = { ...DEFAULT_NOTIFICATIONS, ...(input.notifications || {}) };
  for (const key of Object.keys(DEFAULT_NOTIFICATIONS)) notifications[key] = notifications[key] !== false;
  const providerInput = Array.isArray(input.providers) ? input.providers : PROVIDERS;
  const providerIds = new Set();
  const providers = providerInput.map(normalizeProvider).filter((provider) => {
    if (!provider.id || providerIds.has(provider.id)) return false;
    providerIds.add(provider.id);
    return true;
  });
  const requestedDuration = Number(input.statusDurationSeconds);
  const statusDurationSeconds = ALLOWED_DURATIONS.has(requestedDuration) ? requestedDuration : DEFAULT_DURATION_SECONDS;
  return {
    version: 3,
    productName: 'CodeLight',
    notifications,
    statusDurationSeconds,
    providers,
    devices,
    enabledTools: providers.filter((provider) => provider.enabled).map((provider) => provider.id),
  };
}

function devicesForSource(settings, source) {
  const id = normalizeProviderId(source);
  const normalized = normalizeSettings(settings);
  const provider = normalized.providers.find((item) => item.id === id);
  if (provider?.enabled === false) return [];
  return normalized.devices.filter((device) => device.enabled && (device.sources.includes('*') || device.sources.includes(id)));
}

function effectiveDurationSeconds(settings) {
  const value = normalizeSettings(settings).statusDurationSeconds;
  return value === 0 ? 315_360_000 : value;
}

function nextAvailableProviderId(input, preferredIds = []) {
  const settings = normalizeSettings(input);
  const assigned = new Set(settings.devices
    .filter((device) => device.enabled)
    .flatMap((device) => device.sources)
    .filter((source) => source !== '*'));
  const preferred = [...new Set(preferredIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const order = [
    ...preferred.flatMap((id) => settings.providers.filter((provider) => provider.id === id)),
    ...settings.providers.filter((provider) => provider.pinned),
    ...settings.providers.filter((provider) => !provider.pinned),
  ].filter((provider, index, items) => provider.enabled && items.findIndex((item) => item.id === provider.id) === index);
  return order.find((provider) => !assigned.has(provider.id))?.id || order[0]?.id || '*';
}

module.exports = {
  DEFAULT_NOTIFICATIONS, DEFAULT_DURATION_SECONDS, ALLOWED_DURATIONS,
  normalizeProvider, normalizeDevice, normalizeSettings, devicesForSource, effectiveDurationSeconds, nextAvailableProviderId,
};
