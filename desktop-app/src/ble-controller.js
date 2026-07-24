'use strict';

(() => {
  const SERVICE_UUID = 0xfff0;
  const WRITE_UUID = 0xfff3;
  const POWER_OFF = Uint8Array.from([0xbc, 0x01, 0x01, 0x00, 0x55]);
  const POWER_ON = Uint8Array.from([0xbc, 0x01, 0x01, 0x01, 0x55]);
  const MAX_BRIGHTNESS = Uint8Array.from([0xbc, 0x05, 0x06, 0x03, 0xe8, 0, 0, 0, 0, 0x55]);
  const ZERO_BRIGHTNESS = Uint8Array.from([0xbc, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0x55]);
  const HUES = { red: 0, yellow: 60, green: 120, blue: 240 };

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function colorFrame(color) {
    const hue = HUES[color];
    if (hue === undefined) throw new Error(`Unsupported color: ${color}`);
    const saturation = 1000;
    return Uint8Array.from([
      0xbc, 0x04, 0x06,
      (hue >> 8) & 0xff, hue & 0xff,
      (saturation >> 8) & 0xff, saturation & 0xff,
      0, 0, 0x55,
    ]);
  }

  class JTXBleController {
    constructor({ deviceId = '', onStatus = () => {}, onLog = () => {} } = {}) {
      this.preferredDeviceId = deviceId;
      this.onStatus = onStatus;
      this.onLog = onLog;
      this.device = null;
      this.characteristic = null;
      this.ready = false;
      this.generation = 0;
      this.desiredState = 'off';
      this.chargerSilence = true;
      this.silenceTimer = setInterval(() => {
        if (this.chargerSilence && this.desiredState === 'off') this.write(ZERO_BRIGHTNESS, true).catch(() => {});
      }, 1000);
    }

    status(state, detail = '') {
      const value = { state, id: this.device?.id || this.preferredDeviceId, name: this.device?.name || 'JTX-RGB', detail };
      this.onStatus(value);
      window.agentLight?.reportBleStatus(value);
    }

    async restore(deviceId = this.preferredDeviceId) {
      if (!navigator.bluetooth?.getDevices) return false;
      const devices = await navigator.bluetooth.getDevices();
      const remembered = devices.find((device) => deviceId && device.id === deviceId)
        || devices.find((device) => !deviceId && (device.name || '').toUpperCase().includes('JTX-RGB'));
      if (!remembered) return false;
      this.device = remembered;
      this.preferredDeviceId = remembered.id;
      return this.connectDevice();
    }

    async connect(requestPermission = true) {
      if (!navigator.bluetooth) throw new Error('当前系统没有提供 Web Bluetooth');
      if (this.ready) return true;
      if (!this.device && requestPermission) {
        this.status('selecting', '请选择 JTX-RGB');
        this.device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'JTX-RGB' }],
          optionalServices: [SERVICE_UUID],
        });
        this.preferredDeviceId = this.device.id;
      }
      if (!this.device) return false;
      return this.connectDevice();
    }

    async connectDevice() {
      this.status('connecting', '正在打开 FFF0/FFF3 控制通道');
      this.device.removeEventListener('gattserverdisconnected', this.disconnected);
      this.disconnected = () => {
        this.ready = false;
        this.characteristic = null;
        this.status('disconnected', '连接中断，3 秒后自动重连');
        setTimeout(() => this.connect(false).catch(() => {}), 3000);
      };
      this.device.addEventListener('gattserverdisconnected', this.disconnected);
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      this.characteristic = await service.getCharacteristic(WRITE_UUID);
      // The lamp accepts GATT writes before its command parser is ready, but
      // silently drops them. The observed firmware needs about 1.5 seconds.
      await wait(1500);
      this.ready = true;
      this.status('ready', 'FFF0/FFF3 已连接');
      this.onLog('BLE 已连接', this.device.name || 'JTX-RGB');
      await this.display(this.desiredState, false);
      return true;
    }

    async write(frame, quiet = false) {
      if (!this.ready || !this.characteristic) return false;
      if (typeof this.characteristic.writeValueWithoutResponse === 'function') {
        await this.characteristic.writeValueWithoutResponse(frame);
      } else {
        await this.characteristic.writeValue(frame);
      }
      if (!quiet) this.onLog('BLE 写入', [...frame].map((byte) => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase());
      return true;
    }

    async display(state, burst = true) {
      this.desiredState = state;
      const generation = ++this.generation;
      if (!this.ready) return false;
      if (state === 'off') {
        await this.write(POWER_OFF);
        if (this.chargerSilence) await this.write(ZERO_BRIGHTNESS);
        return true;
      }

      const steps = burst ? [
        [0, ZERO_BRIGHTNESS], [20, POWER_ON], [40, colorFrame(state)], [60, MAX_BRIGHTNESS],
        [200, ZERO_BRIGHTNESS], [300, colorFrame(state)], [320, MAX_BRIGHTNESS],
        [460, ZERO_BRIGHTNESS], [560, colorFrame(state)], [580, MAX_BRIGHTNESS],
        [720, ZERO_BRIGHTNESS], [820, colorFrame(state)], [840, MAX_BRIGHTNESS],
      ] : [[0, ZERO_BRIGHTNESS], [20, POWER_ON], [40, colorFrame(state)], [60, MAX_BRIGHTNESS]];

      for (const [delay, frame] of steps) {
        setTimeout(() => {
          if (generation === this.generation && this.desiredState === state) this.write(frame).catch(() => {});
        }, delay);
      }
      return true;
    }

    setChargerSilence(enabled) {
      this.chargerSilence = Boolean(enabled);
      if (this.desiredState === 'off') {
        const frame = this.chargerSilence ? ZERO_BRIGHTNESS : MAX_BRIGHTNESS;
        this.write(frame).catch(() => {});
      }
    }

    close() {
      clearInterval(this.silenceTimer);
      ++this.generation;
      this.device?.gatt?.disconnect();
    }

    descriptor() {
      return this.device ? { id: this.device.id, name: this.device.name || 'JTX-RGB' } : null;
    }
  }

  window.JTXBleController = JTXBleController;
})();
