'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadController(bluetooth) {
  const window = {};
  const context = {
    window,
    navigator: { bluetooth },
    Uint8Array,
    Error,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (callback) => { callback(); return 1; },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'ble-controller.js'), 'utf8'),
    context,
    { filename: 'ble-controller.js' },
  );
  return window.JTXBleController;
}

test('Windows picker scans case-insensitively in the main process and opens canonical FFF0/FFF3 UUIDs', async () => {
  let requestOptions;
  let serviceUuid;
  let characteristicUuid;
  let withResponseWrites = 0;
  let withoutResponseWrites = 0;
  const characteristic = {
    properties: { write: false, writeWithoutResponse: true },
    writeValueWithResponse: async () => { withResponseWrites += 1; },
    writeValueWithoutResponse: async () => { withoutResponseWrites += 1; },
  };
  const device = {
    id: 'windows-device-a',
    name: 'jtx-rgb',
    addEventListener: () => {},
    removeEventListener: () => {},
    gatt: {
      connected: false,
      connect: async () => ({
        getPrimaryService: async (uuid) => {
          serviceUuid = uuid;
          return {
            getCharacteristic: async (uuidValue) => {
              characteristicUuid = uuidValue;
              return characteristic;
            },
          };
        },
      }),
      disconnect: () => {},
    },
  };
  const Controller = loadController({
    requestDevice: async (options) => { requestOptions = options; return device; },
  });
  const controller = new Controller();
  assert.equal(await controller.connect(true), true);
  assert.equal(requestOptions.acceptAllDevices, true);
  assert.deepEqual(Array.from(requestOptions.optionalServices), ['0000fff0-0000-1000-8000-00805f9b34fb']);
  assert.equal(serviceUuid, '0000fff0-0000-1000-8000-00805f9b34fb');
  assert.equal(characteristicUuid, '0000fff3-0000-1000-8000-00805f9b34fb');
  assert.equal(withResponseWrites, 0);
  assert.ok(withoutResponseWrites >= 2);
  controller.close();
});

test('Windows GATT connection retries transient failures before reporting ready', async () => {
  let attempts = 0;
  const characteristic = {
    properties: { write: true, writeWithoutResponse: false },
    writeValueWithResponse: async () => {},
  };
  const device = {
    id: 'windows-device-b', name: 'JTX-RGB',
    addEventListener: () => {}, removeEventListener: () => {},
    gatt: {
      connected: false,
      connect: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient GATT failure');
        return { getPrimaryService: async () => ({ getCharacteristic: async () => characteristic }) };
      },
      disconnect: () => {},
    },
  };
  const Controller = loadController({ requestDevice: async () => device });
  const statuses = [];
  const controller = new Controller({ onStatus: (status) => statuses.push(status) });
  assert.equal(await controller.connect(true), true);
  assert.equal(attempts, 3);
  assert.equal(statuses.at(-1).state, 'ready');
  controller.close();
});
