'use strict';

(() => {
  const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
  const WRITE_UUID = '0000fff3-0000-1000-8000-00805f9b34fb';
  const POWER_OFF = Uint8Array.from([0xbc, 0x01, 0x01, 0x00, 0x55]);
  const POWER_ON = Uint8Array.from([0xbc, 0x01, 0x01, 0x01, 0x55]);
  const MAX_BRIGHTNESS = Uint8Array.from([0xbc, 0x05, 0x06, 0x03, 0xe8, 0, 0, 0, 0, 0x55]);
  const ZERO_BRIGHTNESS = Uint8Array.from([0xbc, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0x55]);
  const STATIC_MODE = Uint8Array.from([0xbc, 0x06, 0x02, 0, 0x93, 0x55]);
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
      this.connectionGeneration = 0;
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
      return this.connect(false);
    }

    async connect(requestPermission = true, forceSelection = false) {
      if (!navigator.bluetooth) throw new Error('当前系统没有提供 Web Bluetooth');
      if (this.ready && !forceSelection) return true;
      const connectionGeneration = ++this.connectionGeneration;
      if (forceSelection) {
        ++this.generation;
        this.ready = false;
        this.characteristic = null;
        const previousDevice = this.device;
        if (previousDevice && this.disconnected) previousDevice.removeEventListener('gattserverdisconnected', this.disconnected);
        this.device = null;
        if (previousDevice?.gatt?.connected) previousDevice.gatt.disconnect();
      }
      if (!this.device && requestPermission) {
        this.status('selecting', '正在搜索 JTX-RGB，请在 CodeLight 中点击设备');
        this.device = await navigator.bluetooth.requestDevice({
          // Some units advertise as lowercase `jtx-rgb`. Electron's namePrefix
          // filter is case-sensitive, so let the main process filter safely.
          acceptAllDevices: true,
          optionalServices: [SERVICE_UUID],
        });
        this.preferredDeviceId = this.device.id;
      }
      if (!this.device) return false;
      return this.connectDevice(connectionGeneration);
    }

    async connectDevice(connectionGeneration = this.connectionGeneration) {
      this.status('connecting', '正在打开 FFF0/FFF3 控制通道');
      const connectingDevice = this.device;
      if (this.disconnected) connectingDevice.removeEventListener('gattserverdisconnected', this.disconnected);
      let lastError = null;
      let lastStage = 'gatt';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          lastStage = 'gatt';
          const server = await connectingDevice.gatt.connect();
          lastStage = 'service';
          const service = await server.getPrimaryService(SERVICE_UUID);
          lastStage = 'characteristic';
          this.characteristic = await service.getCharacteristic(WRITE_UUID);
          lastError = null;
          break;
        } catch (error) {
          if (connectionGeneration !== this.connectionGeneration || connectingDevice !== this.device) {
            throw new Error('连接请求已被新的设备选择替代');
          }
          lastError = error;
          this.characteristic = null;
          if (connectingDevice.gatt?.connected) connectingDevice.gatt.disconnect();
          if (attempt < 3) {
            this.status('connecting', `Windows GATT 第 ${attempt} 次连接失败，正在重试`);
            await wait(700 * attempt);
          }
        }
      }
      if (lastError || !this.characteristic) {
        const detail = lastStage === 'service'
          ? '已找到设备，但没有 FFF0 控制服务'
          : lastStage === 'characteristic'
            ? '已找到 FFF0，但没有 FFF3 写入通道'
            : 'Windows 无法建立 GATT 连接；请关闭手机 Colorful Lights 后重试';
        this.status('error', detail);
        throw new Error(`${detail}${lastError?.message ? `（${lastError.message}）` : ''}`);
      }
      if (connectionGeneration !== this.connectionGeneration || connectingDevice !== this.device) {
        throw new Error('连接请求已被新的设备选择替代');
      }
      this.disconnected = () => {
        if (this.device !== connectingDevice) return;
        this.ready = false;
        this.characteristic = null;
        this.status('disconnected', '连接中断，3 秒后自动重连');
        setTimeout(() => {
          if (this.device === connectingDevice && !this.ready) this.connect(false).catch(() => {});
        }, 3000);
      };
      connectingDevice.addEventListener('gattserverdisconnected', this.disconnected);
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
      const properties = this.characteristic.properties || {};
      if (properties.write && typeof this.characteristic.writeValueWithResponse === 'function') {
        await this.characteristic.writeValueWithResponse(frame);
      } else if (properties.writeWithoutResponse && typeof this.characteristic.writeValueWithoutResponse === 'function') {
        await this.characteristic.writeValueWithoutResponse(frame);
      } else if (typeof this.characteristic.writeValue === 'function') {
        await this.characteristic.writeValue(frame);
      } else if (typeof this.characteristic.writeValueWithoutResponse === 'function') {
        await this.characteristic.writeValueWithoutResponse(frame);
      } else {
        throw new Error('FFF3 特征不可写');
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
        [0, ZERO_BRIGHTNESS], [20, POWER_ON], [30, STATIC_MODE], [40, colorFrame(state)], [60, MAX_BRIGHTNESS],
        [180, ZERO_BRIGHTNESS], [280, colorFrame(state)], [300, MAX_BRIGHTNESS],
        [420, ZERO_BRIGHTNESS], [520, colorFrame(state)], [540, MAX_BRIGHTNESS],
        [660, ZERO_BRIGHTNESS], [760, colorFrame(state)], [780, MAX_BRIGHTNESS],
        [900, ZERO_BRIGHTNESS], [1000, colorFrame(state)], [1020, MAX_BRIGHTNESS],
        [1140, ZERO_BRIGHTNESS], [1240, colorFrame(state)], [1260, MAX_BRIGHTNESS],
        [1380, ZERO_BRIGHTNESS], [1480, colorFrame(state)], [1500, MAX_BRIGHTNESS],
      ] : [[0, ZERO_BRIGHTNESS], [20, POWER_ON], [30, STATIC_MODE], [40, colorFrame(state)], [60, MAX_BRIGHTNESS]];

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
      ++this.connectionGeneration;
      const device = this.device;
      if (device && this.disconnected) device.removeEventListener('gattserverdisconnected', this.disconnected);
      this.ready = false;
      this.characteristic = null;
      device?.gatt?.disconnect();
    }

    descriptor() {
      return this.device ? { id: this.device.id, name: this.device.name || 'JTX-RGB' } : null;
    }
  }

  window.JTXBleController = JTXBleController;
})();
