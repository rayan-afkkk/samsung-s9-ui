// OneShell main process: owns the shell windows (desktop, dock, overlay, settings),
// the native helper and the state pushed to the UI.
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, powerMonitor, globalShortcut,
  desktopCapturer, dialog, nativeImage,
} = require('electron');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const config = require('./config');
const native = require('./native');
const apps = require('./apps');
const system = require('./system');

// Every screen is designed on a 1600x1000 canvas (the mockups) and zoomed to fit the display.
const DESIGN_W = 1600;
const DESIGN_H = 1000;
const DOCK_WINDOW_H = 200;  // room for the floating dock + nav bar on the home screen
const TASKBAR_H = 120;      // full-width taskbar while an app is open

const UI = path.join(__dirname, '..', 'renderer', 'ui.html');
const PRELOAD = path.join(__dirname, '..', 'preload.js');

let desktopWin, dockWin, overlayWin, settingsWin, tray;
let overlayMode = null;
let dockMode = 'home';
let lastSsid = null;
let appList = [];
const history = []; // recently launched app ids, newest first
const iconCache = new Map();

const state = {
  battery: null, volume: null, brightness: null, wifi: null, stats: null, weather: null,
  screenTime: null, nowPlaying: null, windows: [], powerPlan: null, build: null,
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// A shell must keep running: log unexpected errors to %APPDATA%\OneShell\oneshell.log
// instead of showing Electron's crash dialog.
const fs = require('fs');
function logLine(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (p && p.stack) || String(p)).join(' ')}\n`;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'oneshell.log'), line); } catch {}
}
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { orig(...a); if (level !== 'log') logLine(level, ...a); };
}
process.on('uncaughtException', (err) => console.error('uncaught', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection', err));

// ---------------------------------------------------------------- helpers
function display() {
  return screen.getPrimaryDisplay();
}

function scale() {
  const { width, height } = display().bounds;
  return Math.min(width / DESIGN_W, height / DESIGN_H);
}

function allWindows() {
  return [desktopWin, dockWin, overlayWin, settingsWin].filter((w) => w && !w.isDestroyed());
}

function broadcast(channel, payload) {
  for (const w of allWindows()) w.webContents.send(channel, payload);
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

function fileUrl(p) {
  return p ? pathToFileURL(p).href : null;
}

function publicConfig() {
  const c = config.get();
  return {
    ...c,
    wallpaperUrl: fileUrl(c.wallpaper),
    lockPhotoUrl: fileUrl(c.lockPhoto),
    photoUrls: (c.photos || []).map(fileUrl),
    scale: scale(),
    designW: DESIGN_W,
    designH: DESIGN_H,
    platform: process.platform,
    win11: (state.build || 0) >= 22000,
    version: app.getVersion(),
    user: os.userInfo().username,
  };
}

function sameExe(a, b) {
  return a && b && a.toLowerCase() === b.toLowerCase();
}

async function iconForExe(exe) {
  if (!exe) return null;
  if (iconCache.has(exe)) return iconCache.get(exe);
  const url = await native.call('icon', { path: exe });
  iconCache.set(exe, url);
  return url;
}

// ---------------------------------------------------------------- windows
function baseWindow(opts) {
  return new BrowserWindow({
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    ...opts,
  });
}

function load(win, view) {
  win.loadFile(UI, { query: { view } });
}

function createWindows() {
  desktopWin = baseWindow({ backgroundColor: '#dfe9f7', movable: false, focusable: true });
  load(desktopWin, 'desktop');
  desktopWin.once('ready-to-show', () => {
    desktopWin.showInactive();
    native.call('toolWindow', { hwnd: hwndOf(desktopWin) });
    native.call('toBottom', { hwnd: hwndOf(desktopWin) });
  });
  // The desktop must stay behind every app, even when clicked or after Win+D.
  desktopWin.on('focus', () => native.call('toBottom', { hwnd: hwndOf(desktopWin) }));
  desktopWin.on('minimize', () => desktopWin.restore());

  dockWin = baseWindow({ transparent: true, hasShadow: false, focusable: false, alwaysOnTop: true, movable: false });
  dockWin.setAlwaysOnTop(true, 'pop-up-menu');
  dockWin.setIgnoreMouseEvents(true, { forward: true });
  load(dockWin, 'dock');
  dockWin.once('ready-to-show', () => {
    if (config.get().replaceTaskbar) dockWin.showInactive();
    native.call('toolWindow', { hwnd: hwndOf(dockWin) });
  });

  overlayWin = baseWindow({ transparent: true, hasShadow: false, alwaysOnTop: true, movable: false });
  load(overlayWin, 'overlay');
  overlayWin.once('ready-to-show', () => native.call('toolWindow', { hwnd: hwndOf(overlayWin) }));
  overlayWin.on('blur', () => {
    // Clicking another window closes the quick panel / drawer / recents, never the lock screen.
    if (overlayMode && overlayMode !== 'lock') hideOverlay();
  });

  layout();
}

let lastLayout = '';

// Positions the shell windows and reserves screen space for the dock. Only does work when the
// display really changed: reserving the work area itself fires display-metrics-changed, so
// reacting to every event would loop forever (lag, 100% CPU, flickering dock).
function layout(force = false) {
  const d = display();
  const b = d.bounds;
  const s = scale();
  const replace = config.get().replaceTaskbar;
  const key = JSON.stringify([b, d.scaleFactor, replace]);
  if (!force && key === lastLayout) return;
  const scaleChanged = !lastLayout || JSON.parse(lastLayout)[1] !== d.scaleFactor || JSON.parse(lastLayout)[0].width !== b.width;
  lastLayout = key;

  desktopWin.setBounds(replace ? b : d.workArea);
  overlayWin.setBounds(b);
  const dockH = Math.round(DOCK_WINDOW_H * s);
  dockWin.setBounds({ x: b.x, y: b.y + b.height - dockH, width: b.width, height: dockH });

  if (replace) {
    native.call('hideTaskbar');
    native.call('setWorkArea', { top: 0, bottom: Math.round(TASKBAR_H * s * d.scaleFactor) });
    if (!dockWin.isVisible()) dockWin.showInactive();
  } else {
    native.call('showTaskbar');
    native.call('restoreWorkArea');
    dockWin.hide();
  }
  if (scaleChanged || force) broadcast('config', publicConfig());
}

function applyHooks() {
  const c = config.get();
  native.call('setHooks', { winKey: c.replaceStart, winA: c.hookWinA, winTab: c.hookWinTab });
  native.call('setRoundCorners', { on: c.roundedWindows });
}

function ourPids() {
  const pids = new Set([process.pid]);
  for (const m of app.getAppMetrics()) pids.add(m.pid);
  return [...pids];
}

// ---------------------------------------------------------------- overlay (lock / quick / drawer / recents)
async function showOverlay(mode, extra = {}) {
  if (!overlayWin) return;
  if (overlayMode === mode && mode !== 'lock') return hideOverlay();
  overlayMode = mode;
  if (mode === 'recents') extra.recents = await recentsData();
  overlayWin.webContents.send('overlay', { mode, ...extra });
  overlayWin.setAlwaysOnTop(true, mode === 'lock' ? 'screen-saver' : 'pop-up-menu');
  overlayWin.show();
  overlayWin.moveTop();
  overlayWin.focus();
  native.call('activate', { hwnd: hwndOf(overlayWin) });
}

function hideOverlay() {
  if (!overlayMode) return;
  overlayMode = null;
  overlayWin.webContents.send('overlay', { mode: null });
  setTimeout(() => { if (!overlayMode) overlayWin.hide(); }, config.get().animations ? 200 : 0);
}

async function recentsData() {
  const windows = (await native.call('listWindows')) || [];
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 960, height: 720 } });
  } catch {}
  const thumbs = new Map();
  for (const src of sources) {
    const m = /^window:(\d+):/.exec(src.id);
    if (m && !src.thumbnail.isEmpty()) thumbs.set(Number(m[1]), src.thumbnail.toDataURL());
  }
  return Promise.all(
    windows.map(async (w) => ({ ...w, icon: await iconForExe(w.exe), thumb: thumbs.get(w.hwnd) || null })),
  );
}

// ---------------------------------------------------------------- settings window
function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (section) settingsWin.webContents.send('settings:section', section);
    return;
  }
  const s = scale();
  const b = display().workArea;
  const w = Math.round(1300 * s);
  const h = Math.round(900 * s);
  settingsWin = baseWindow({
    width: w, height: h,
    x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - h) / 2),
    transparent: true, skipTaskbar: false, minimizable: true, maximizable: true, movable: true, title: 'OneShell',
  });
  settingsWin.loadFile(UI, { query: { view: 'settings', section: section || '' } });
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------------------------------------------------------------- work-area geometry for split / pop-up
function workAreaPx() {
  const d = display();
  const f = d.scaleFactor;
  const b = d.bounds;
  const bottom = config.get().replaceTaskbar ? TASKBAR_H * scale() : b.height - d.workArea.height;
  return { x: Math.round(b.x * f), y: Math.round(b.y * f), w: Math.round(b.width * f), h: Math.round((b.height - bottom) * f) };
}

async function split(hwnd) {
  const wins = (await native.call('listWindows')) || [];
  const other = wins.find((w) => w.hwnd !== hwnd);
  const a = workAreaPx();
  const half = Math.floor(a.w / 2);
  await native.call('place', { hwnd, x: a.x, y: a.y, w: half, h: a.h });
  if (other) await native.call('place', { hwnd: other.hwnd, x: a.x + half, y: a.y, w: a.w - half, h: a.h });
  hideOverlay();
  native.call('activate', { hwnd });
}

async function popup(hwnd) {
  const a = workAreaPx();
  const w = Math.round(a.w * 0.28);
  const h = Math.round(a.h * 0.55);
  await native.call('place', { hwnd, x: a.x + a.w - w - Math.round(a.w * 0.03), y: a.y + a.h - h - Math.round(a.h * 0.05), w, h });
  await native.call('topmost', { hwnd, on: true });
  hideOverlay();
  native.call('activate', { hwnd });
}

// ---------------------------------------------------------------- dock actions
function findApp(id) {
  return appList.find((a) => a.id === id);
}

function remember(id) {
  const i = history.indexOf(id);
  if (i >= 0) history.splice(i, 1);
  history.unshift(id);
  history.length = Math.min(history.length, 10);
}

function launch(id) {
  const a = findApp(id);
  if (!a) return;
  remember(id);
  apps.launch(a);
  hideOverlay();
}

async function openFromDock(id) {
  const a = findApp(id);
  const wins = state.windows.filter((w) => a && sameExe(w.exe, a.exe));
  if (!wins.length) return launch(id);
  const fg = wins.find((w) => w.foreground && !w.minimized);
  if (fg) return native.call('minimize', { hwnd: fg.hwnd });
  remember(id);
  native.call('activate', { hwnd: wins[0].hwnd });
}

function dockModel() {
  const c = config.get();
  const pinnedIds = c.pinned || [];
  const running = state.windows;
  const pinned = pinnedIds.map(findApp).filter(Boolean).map((a) => ({
    kind: 'app', id: a.id, name: a.name, icon: a.icon, running: running.some((w) => sameExe(w.exe, a.exe)),
  }));
  // "Recent" section: running apps that aren't pinned, then recently launched ones.
  const recent = [];
  for (const w of running) {
    if (recent.length >= 3) break;
    if (pinned.some((p) => sameExe(findApp(p.id).exe, w.exe))) continue;
    if (recent.some((r) => sameExe(r.exe, w.exe))) continue;
    const a = appList.find((x) => sameExe(x.exe, w.exe));
    recent.push({ kind: 'window', hwnd: w.hwnd, exe: w.exe, id: a && a.id, name: (a && a.name) || w.app, icon: (a && a.icon) || w.icon, running: true });
  }
  for (const id of history) {
    if (recent.length >= 3) break;
    if (pinnedIds.includes(id) || recent.some((r) => r.id === id)) continue;
    const a = findApp(id);
    if (a) recent.push({ kind: 'app', id: a.id, name: a.name, icon: a.icon, running: false });
  }
  return { pinned, recent, mode: dockMode };
}

let lastDock = '';
function pushDock(force = false) {
  if (!dockWin || dockWin.isDestroyed()) return;
  const model = dockModel();
  const key = JSON.stringify(model);
  if (!force && key === lastDock) return;
  lastDock = key;
  dockWin.webContents.send('dock', model);
}

// ---------------------------------------------------------------- state polling
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    broadcast('state', state);
    pushDock();
  }, 150);
}

let polling = null;
function pollWindows() {
  // Coalesce: foreground events can arrive in bursts.
  if (!polling) {
    polling = (async () => {
      const wins = (await native.call('listWindows')) || [];
      for (const w of wins) w.icon = await iconForExe(w.exe);
      state.windows = wins;
      state.nowPlaying = system.nowPlaying(wins);
      // One UI shows the taskbar only while an app is open in front; tool windows such as the
      // Snipping Tool recorder or our own panels don't count.
      const mode = wins.some((w) => w.foreground && !w.minimized) ? 'taskbar' : 'home';
      if (overlayMode !== 'lock' && mode !== dockMode) dockMode = mode;
      pushState();
    })().finally(() => { polling = null; });
  }
  return polling;
}

async function pollFast() {
  state.volume = await native.call('getVolume');
  await pollWindows();
}

async function pollMedium() {
  state.battery = await native.call('battery');
  state.stats = await system.stats();
  pushState();
}

async function pollSlow() {
  state.wifi = await system.wifi();
  if (state.wifi && state.wifi.ssid) lastSsid = state.wifi.ssid;
  state.brightness = await native.call('getBrightness');
  state.screenTime = system.screenTime();
  state.powerPlan = await system.powerPlan();
  pushState();
}

async function pollWeather(force) {
  const c = config.get();
  state.weather = await system.weather(c.city, c.units, force);
  pushState();
}

function every(ms, fn) {
  fn();
  return setInterval(fn, ms);
}

// ---------------------------------------------------------------- quick panel actions
async function quickToggle(name) {
  switch (name) {
    case 'wifi':
      if (state.wifi && state.wifi.hasWlan) await system.wifiToggle(state.wifi.ssid, lastSsid);
      else apps.openUri('ms-settings:network-wifi');
      setTimeout(pollSlow, 1500);
      break;
    case 'bluetooth': apps.openUri('ms-settings:bluetooth'); hideOverlay(); break;
    case 'sound':
      state.volume = await native.call('setMute', { mute: !(state.volume && state.volume.mute) });
      pushState();
      break;
    case 'dark': await setConfig({ darkMode: !config.get().darkMode }); break;
    case 'eye': apps.openUri('ms-settings:nightlight'); hideOverlay(); break;
    case 'airplane': apps.openUri('ms-settings:network-airplanemode'); hideOverlay(); break;
    case 'snap': {
      const top = state.windows[0];
      if (top) await split(top.hwnd);
      else hideOverlay();
      break;
    }
    case 'screenshot':
      hideOverlay();
      setTimeout(() => native.call('screenshot'), 350);
      break;
    case 'power': apps.openUri('ms-settings:powersleep'); hideOverlay(); break;
  }
}

function power(action) {
  hideOverlay();
  const run = (cmd, args) => execFile(cmd, args, { windowsHide: true });
  switch (action) {
    case 'lock': native.call('lockWorkstation'); break;
    case 'sleep': run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']); break;
    case 'restart': run('shutdown.exe', ['/r', '/t', '0']); break;
    case 'shutdown': run('shutdown.exe', ['/s', '/t', '0']); break;
    case 'signout': run('shutdown.exe', ['/l']); break;
  }
}

// ---------------------------------------------------------------- config changes
async function setConfig(patch) {
  const before = config.get();
  const c = config.set(patch);
  if ('replaceTaskbar' in patch && patch.replaceTaskbar !== before.replaceTaskbar) layout(true);
  if (['replaceStart', 'hookWinA', 'hookWinTab', 'roundedWindows'].some((k) => k in patch)) applyHooks();
  if ('darkMode' in patch) native.call('setDarkMode', { on: c.darkMode });
  if ('autostart' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: c.autostart });
  if ('city' in patch || 'units' in patch) pollWeather(true);
  broadcast('config', publicConfig());
  pushDock(true);
  return publicConfig();
}

// The picture currently set as the Windows desktop background.
function windowsWallpaper() {
  return new Promise((resolve) => {
    const transcoded = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    const fallback = () => resolve(fs.existsSync(transcoded) ? transcoded : null);
    execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], { windowsHide: true }, (err, out) => {
      const m = !err && /WallPaper\s+REG_SZ\s+(.+)/i.exec(out || '');
      const file = m && m[1].trim();
      if (file && fs.existsSync(file)) resolve(file);
      else fallback();
    });
  });
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (e, ...args) => fn(...args));
  h('config:get', () => publicConfig());
  h('config:set', (patch) => setConfig(patch));
  h('state:get', () => state);
  h('dock:get', () => dockModel());
  h('apps:list', async () => {
    appList = await apps.list();
    return appList.map(({ name, id, icon }) => ({ name, id, icon }));
  });
  h('apps:launch', (id) => launch(id));
  h('dock:open', (id) => openFromDock(id));
  h('dock:pin', async (id, pin) => {
    const pinned = (config.get().pinned || []).filter((x) => x !== id);
    if (pin) pinned.push(id);
    return setConfig({ pinned });
  });
  h('win:activate', (hwnd) => { hideOverlay(); return native.call('activate', { hwnd }); });
  h('win:close', (hwnd) => native.call('close', { hwnd }));
  h('win:closeAll', async () => {
    for (const w of (await native.call('listWindows')) || []) await native.call('close', { hwnd: w.hwnd });
    hideOverlay();
  });
  h('win:split', (hwnd) => split(hwnd));
  h('win:popup', (hwnd) => popup(hwnd));
  h('overlay:show', (mode, extra) => showOverlay(mode, extra));
  h('overlay:hide', () => hideOverlay());
  h('nav', async (which) => {
    if (which === 'recents') return showOverlay('recents');
    if (which === 'home') { hideOverlay(); return native.call('minimizeAll'); }
    if (which === 'back') { if (overlayMode && overlayMode !== 'lock') return hideOverlay(); return native.call('back'); }
  });
  h('volume:set', async (level) => { state.volume = await native.call('setVolume', { level }); pushState(); });
  h('brightness:set', (level) => native.call('setBrightness', { level }));
  h('media', (key) => native.call('mediaKey', { key }));
  h('quick:toggle', (name) => quickToggle(name));
  h('power', (action) => power(action));
  h('optimize', async () => {
    const r = await native.call('optimize');
    state.stats = await system.stats();
    pushState();
    return r;
  });
  h('pickImage', async () => {
    const r = await dialog.showOpenDialog(settingsWin || desktopWin, {
      properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  h('settings:open', (section) => { hideOverlay(); openSettings(section); });
  h('wallpaper:windows', () => windowsWallpaper());
  h('open:uri', (uri) => { hideOverlay(); apps.openUri(uri); });
  h('self:close', () => settingsWin && settingsWin.close());
  h('self:minimize', () => settingsWin && settingsWin.minimize());
  h('self:maximize', () => {
    if (!settingsWin) return;
    if (settingsWin.isMaximized()) settingsWin.unmaximize();
    else settingsWin.maximize();
  });
  h('quit', () => app.quit());
  ipcMain.on('dock:mouse', (e, inside) => {
    if (dockWin && !dockWin.isDestroyed()) dockWin.setIgnoreMouseEvents(!inside, { forward: true });
  });
}

// ---------------------------------------------------------------- native events
function registerNative() {
  native.on('ready', (msg) => {
    state.build = msg.build;
    native.call('setIgnorePids', { pids: ourPids() });
    applyHooks();
    // The helper (re)started: hide the taskbar and reserve the dock area again.
    if (desktopWin) layout(true);
  });
  native.on('winkey', () => showOverlay('drawer'));
  native.on('win_a', () => showOverlay('quick'));
  native.on('win_tab', () => showOverlay('recents'));
  native.on('foreground', (fg) => {
    const is = (win) => win && !win.isDestroyed() && fg.hwnd === hwndOf(win);
    if (is(overlayWin)) return; // panels opening on top don't change the dock
    const realDesktop = fg.class === 'Progman' || fg.class === 'WorkerW';
    // Win+D / clicking the real desktop: bring our home screen back above it.
    if (realDesktop && desktopWin) native.call('toBottom', { hwnd: hwndOf(desktopWin) });
    if (realDesktop || is(desktopWin)) dockMode = 'home';
    system.foreground(fg.ours ? null : fg.app);
    pollWindows();
  });
}

// ---------------------------------------------------------------- tray
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('OneShell');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'OneShell settings', click: () => openSettings() },
    { label: 'Show lock screen', click: () => showOverlay('lock') },
    { type: 'separator' },
    {
      label: 'Use the normal Windows taskbar',
      type: 'checkbox',
      checked: !config.get().replaceTaskbar,
      click: (item) => setConfig({ replaceTaskbar: !item.checked }),
    },
    { label: 'Quit OneShell (restores Windows)', click: () => app.quit() },
  ]));
  tray.on('click', () => openSettings());
}

// ---------------------------------------------------------------- lifecycle
app.on('second-instance', () => openSettings());

app.whenReady().then(async () => {
  config.load();
  registerIpc();
  registerNative();
  native.start();
  createWindows();
  createTray();

  // Emergency exit that always brings the real Windows taskbar back.
  globalShortcut.register('Control+Alt+Shift+Q', () => app.quit());

  // Ignore work-area-only changes (we cause those ourselves when reserving room for the dock).
  screen.on('display-metrics-changed', (e, d, changed) => {
    if (changed.includes('bounds') || changed.includes('scaleFactor')) layout();
  });
  screen.on('display-added', () => layout());
  screen.on('display-removed', () => layout());
  powerMonitor.on('resume', () => { if (config.get().lockOnResume) showOverlay('lock'); });

  if (config.get().autostart && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  if (config.get().lockOnStartup) overlayWin.once('ready-to-show', () => showOverlay('lock'));

  every(2000, pollFast);
  every(5000, pollMedium);
  every(15000, pollSlow);
  every(30 * 60 * 1000, () => pollWeather(false));
  setInterval(() => native.call('setIgnorePids', { pids: ourPids() }), 10000);

  appList = await apps.list();
  if (config.get().pinned === null && appList.length) await setConfig({ pinned: apps.defaultPins(appList) });
  pushDock();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  system.flush();
  native.stop();
});

app.on('window-all-closed', (e) => e.preventDefault());

