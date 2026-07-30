'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SERVICE_UUID,
  WRITE_UUID,
  isJtxRgbName,
  normalizeBluetoothCandidates,
  prioritizeUnboundCandidates,
  bluetoothErrorMessage,
} = require('../shared/bluetooth');

test('recognizes JTX-RGB advertisements without case sensitivity', () => {
  assert.equal(isJtxRgbName('JTX-RGB'), true);
  assert.equal(isJtxRgbName('jtx-rgb'), true);
  assert.equal(isJtxRgbName('JTX RGB 01'), true);
  assert.equal(isJtxRgbName('Bluetooth Mouse'), false);
});

test('only exposes compatible lamps and never falls back to an unrelated device', () => {
  assert.deepEqual(normalizeBluetoothCandidates([
    { deviceId: 'mouse', deviceName: 'Bluetooth Mouse' },
    { deviceId: 'lamp-a', deviceName: 'jtx-rgb' },
    { deviceId: 'lamp-a', deviceName: 'JTX-RGB' },
  ]), [{ id: 'lamp-a', name: 'JTX-RGB' }]);
  assert.deepEqual(normalizeBluetoothCandidates([
    { deviceId: 'headset', deviceName: 'Headset' },
  ]), []);
});

test('uses canonical UUIDs accepted consistently by Windows Web Bluetooth', () => {
  assert.equal(SERVICE_UUID, '0000fff0-0000-1000-8000-00805f9b34fb');
  assert.equal(WRITE_UUID, '0000fff3-0000-1000-8000-00805f9b34fb');
});

test('macOS manual pairing puts unbound lamps first and labels connected records', () => {
  const candidates = prioritizeUnboundCandidates([
    { id: 'known', name: 'JTX-RGB', rssi: 0 },
    { id: 'new', name: 'JTX-RGB', rssi: -50 },
  ], [{ id: 'KNOWN', name: '状态灯 A', enabled: true }]);
  assert.equal(candidates[0].id, 'new');
  assert.equal(candidates[0].configured, false);
  assert.equal(candidates[0].configuredEnabled, false);
  assert.equal(candidates[1].configuredName, '状态灯 A');
  assert.equal(candidates[1].configuredEnabled, true);
});

test('turns Windows Web Bluetooth failures into actionable messages', () => {
  assert.match(bluetoothErrorMessage({ name: 'NotFoundError', message: 'User cancelled' }), /没有选择跑马灯/);
  assert.match(bluetoothErrorMessage({ name: 'NetworkError', message: 'GATT operation failed' }), /Colorful Lights/);
  assert.match(bluetoothErrorMessage({ name: 'SecurityError', message: 'Permission denied' }), /蓝牙权限/);
});
