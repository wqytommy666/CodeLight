'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentLight', {
  getState: () => ipcRenderer.invoke('state:get'),
  command: (command) => ipcRenderer.invoke('light:command', command),
  installHooks: () => ipcRenderer.invoke('hooks:install'),
  refreshQuota: () => ipcRenderer.invoke('quota:refresh'),
  scanDevices: () => ipcRenderer.invoke('devices:scan'),
  saveDevice: (device) => ipcRenderer.invoke('devices:save', device),
  removeDevice: (id) => ipcRenderer.invoke('devices:remove', id),
  testDevice: (id, color) => ipcRenderer.invoke('devices:test', { id, color }),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseProviderIcon: () => ipcRenderer.invoke('files:choose-icon'),
  chooseProviderApp: () => ipcRenderer.invoke('files:choose-app'),
  testNotification: (source) => ipcRenderer.invoke('notification:test', source),
  focusTool: (source) => ipcRenderer.invoke('tool:focus', source),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  reportBleStatus: (status) => ipcRenderer.send('ble:status', status),
  hideWindow: () => ipcRenderer.send('window:hide'),
  onSnapshot: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('state:snapshot', listener);
    return () => ipcRenderer.removeListener('state:snapshot', listener);
  },
  onDisplayState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('display:state', listener);
    return () => ipcRenderer.removeListener('display:state', listener);
  },
  onDeviceDisplay: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('device:display', listener);
    return () => ipcRenderer.removeListener('device:display', listener);
  },
  onConnectionRequired: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('connection:required', listener);
    return () => ipcRenderer.removeListener('connection:required', listener);
  },
  onChargerMode: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('charger:mode', listener);
    return () => ipcRenderer.removeListener('charger:mode', listener);
  },
});
