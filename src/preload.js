const { contextBridge, ipcRenderer, webFrame } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const listen = (ch) => (fn) => {
  const handler = (e, payload) => fn(payload);
  ipcRenderer.on(ch, handler);
  return () => ipcRenderer.removeListener(ch, handler);
};

contextBridge.exposeInMainWorld('oneshell', {
  getConfig: invoke('config:get'),
  setConfig: invoke('config:set'),
  getState: invoke('state:get'),
  getDock: invoke('dock:get'),
  listApps: invoke('apps:list'),
  launch: invoke('apps:launch'),
  openFromDock: invoke('dock:open'),
  pin: invoke('dock:pin'),
  activate: invoke('win:activate'),
  closeWindow: invoke('win:close'),
  closeAll: invoke('win:closeAll'),
  split: invoke('win:split'),
  popup: invoke('win:popup'),
  showOverlay: invoke('overlay:show'),
  hideOverlay: invoke('overlay:hide'),
  nav: invoke('nav'),
  setVolume: invoke('volume:set'),
  setBrightness: invoke('brightness:set'),
  media: invoke('media'),
  quickToggle: invoke('quick:toggle'),
  power: invoke('power'),
  optimize: invoke('optimize'),
  pickImage: invoke('pickImage'),
  windowsWallpaper: invoke('wallpaper:windows'),
  openSettings: invoke('settings:open'),
  openUri: invoke('open:uri'),
  closeSelf: invoke('self:close'),
  minimizeSelf: invoke('self:minimize'),
  maximizeSelf: invoke('self:maximize'),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  quit: invoke('quit'),
  dockMouse: (inside) => ipcRenderer.send('dock:mouse', inside),
  onConfig: listen('config'),
  onState: listen('state'),
  onDock: listen('dock'),
  onOverlay: listen('overlay'),
  onSettingsSection: listen('settings:section'),
});
