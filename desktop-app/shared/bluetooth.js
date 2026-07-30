'use strict';

const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const WRITE_UUID = '0000fff3-0000-1000-8000-00805f9b34fb';

function isJtxRgbName(value) {
  return /^jtx[\s_-]*rgb(?:\b|[\s_-]|$)/i.test(String(value || '').trim());
}

function normalizeBluetoothCandidates(devices = []) {
  const found = new Map();
  for (const device of devices) {
    const id = String(device?.deviceId || device?.id || '').trim();
    const name = String(device?.deviceName || device?.name || '').trim();
    if (!id || !isJtxRgbName(name)) continue;
    found.set(id, { id, name: name || 'JTX-RGB' });
  }
  return [...found.values()];
}

function prioritizeUnboundCandidates(devices = [], configuredDevices = []) {
  return devices.map((device) => {
    const configured = configuredDevices.find((item) => String(item?.id || '').toLowerCase() === String(device?.id || '').toLowerCase());
    return {
      ...device,
      configured: Boolean(configured),
      configuredName: configured?.name || '',
      configuredEnabled: Boolean(configured && configured.enabled !== false),
    };
  }).sort((left, right) => Number(left.configured) - Number(right.configured) || Number(right.rssi) - Number(left.rssi));
}

function bluetoothErrorMessage(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '').trim();
  if (name === 'NotFoundError' || /cancel|cancelled|canceled|未选择/i.test(message)) {
    return '没有选择跑马灯。请确认 Windows 蓝牙已打开，并在列表中点击 JTX-RGB。';
  }
  if (name === 'SecurityError' || /permission|denied|not allowed|权限/i.test(message)) {
    return '蓝牙权限被拒绝。请在 Windows“设置 → 隐私和安全性”中允许 CodeLight 使用蓝牙。';
  }
  if (name === 'NetworkError' || /gatt|connect|disconnected|连接/i.test(message)) {
    return '无法建立跑马灯控制通道。请关闭手机 Colorful Lights、让灯靠近电脑后重试。';
  }
  if (/service|fff0/i.test(message)) {
    return '设备没有提供 FFF0 控制服务，可能不是兼容的 JTX-RGB 跑马灯。';
  }
  if (/characteristic|fff3/i.test(message)) {
    return '设备没有提供 FFF3 写入通道，当前灯具协议可能不同。';
  }
  return message || '蓝牙连接失败，请确认设备已开机且没有被手机 App 占用。';
}

module.exports = {
  SERVICE_UUID,
  WRITE_UUID,
  isJtxRgbName,
  normalizeBluetoothCandidates,
  prioritizeUnboundCandidates,
  bluetoothErrorMessage,
};
