// Fake `window.oneshell` for working on the UI in a normal browser (no Electron, no Windows).
// Open ui.html?view=desktop|dock|overlay|settings; add &mode=lock|quick|drawer|recents for the
// overlay and &dock=taskbar for the dock. Inside Electron the preload defines the real API first.
(() => {
  if (window.oneshell) return;
  const q = new URLSearchParams(location.search);
  const listeners = {};
  const on = (ch) => (fn) => { (listeners[ch] = listeners[ch] || []).push(fn); };
  const emit = (ch, v) => (listeners[ch] || []).forEach((fn) => fn(v));

  const glyph = (bg, path) =>
    'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient></defs><rect width="64" height="64" rx="22" fill="url(#g)"/><g fill="none" stroke="${bg[2] || '#fff'}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" transform="translate(15 15) scale(1.42)">${path}</g></svg>`);
  const P = {
    note: '<path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    term: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    gear: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="4"/><path d="M10 9l5 3-5 3z" fill="#fff"/>',
    spark: '<path d="M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    photo: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 7l9 6 9-6"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    calc: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M8 7h8M8 12h2M14 12h2M8 16h2M14 16h2"/>',
    game: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    store: '<path d="M4 8h16l-1 12H5z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
  };
  const C = {
    red: ['#ff6b6b', '#e2353b'], org: ['#ffc35a', '#f39a1e'], blu: ['#6aa5ff', '#2f6bf0'], grn: ['#4fdc7d', '#1faa52'],
    wht: ['#fff', '#fff', '#3e7bfa'], pur: ['#a98bff', '#6b4ae0'], dk: ['#454e5f', '#262c37'], tea: ['#4fd6d0', '#13a39d'],
    pnk: ['#ff8fc4', '#e84c94'], gry: ['#c7ced9', '#8f99a8'],
  };
  const list = [
    ['Notes', 'red', 'note'], ['File Explorer', 'org', 'folder'], ['Google Chrome', 'blu', 'globe'], ['Messages', 'wht', 'chat'],
    ['Terminal', 'dk', 'term'], ['Visual Studio Code', 'pur', 'code'], ['Settings', 'gry', 'gear'], ['YouTube', 'red', 'play'],
    ['WhatsApp', 'grn', 'chat'], ['Gemini', 'wht', 'spark'], ['Spotify', 'grn', 'music'], ['Photos', 'pnk', 'photo'],
    ['Mail', 'blu', 'mail'], ['Calendar', 'tea', 'cal'], ['Microsoft Store', 'blu', 'store'], ['Calculator', 'org', 'calc'],
    ['Xbox', 'grn', 'game'], ['Clock', 'dk', 'clock'], ['Camera', 'gry', 'cam'], ['People', 'red', 'user'],
    ['Word', 'blu', 'note'], ['Excel', 'grn', 'calc'], ['PowerPoint', 'red', 'photo'], ['Discord', 'pur', 'chat'],
    ['Steam', 'dk', 'game'], ['Notepad', 'tea', 'note'], ['Paint', 'pnk', 'photo'], ['Snipping Tool', 'pur', 'cam'],
    ['Task Manager', 'gry', 'clock'], ['Control Panel', 'blu', 'gear'], ['Device care', 'tea', 'gear'], ['Tools', 'gry', 'folder'],
    ['Zoom', 'blu', 'cam'], ['Telegram', 'blu', 'chat'],
  ];
  const apps = list.map(([name, c, p]) => ({ name, id: name, icon: glyph(C[c], P[p]) }));
  const app = (n) => apps.find((a) => a.name === n);

  let config = {
    replaceTaskbar: true, replaceStart: true, navButtons: q.get('nav') === '1', hookWinA: true, hookWinTab: true,
    wallpaper: null, wallpaperUrl: null, wallpaperPreset: q.get('wp') || 'blue', accent: '#3e7bfa', darkMode: q.get('dark') === '1',
    photos: [null, null, null, null, null, null], photoUrls: [null, null, null, null, null, null],
    lockPhoto: null, lockPhotoUrl: null, city: '', units: 'C', showSearch: true,
    pinned: ['Notes', 'File Explorer', 'Google Chrome', 'Messages', 'Terminal', 'Visual Studio Code', 'Settings'],
    lockOnStartup: true, lockOnResume: true, roundedWindows: true, animations: true, autostart: true,
    scale: 1, version: '0.1.0', user: 'Rayan', win11: true,
  };
  const thumb = (bg) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${bg}"/><rect x="30" y="30" width="740" height="60" rx="30" fill="#eef2f8"/><rect x="30" y="120" width="740" height="300" rx="24" fill="#5d87b8"/><rect x="30" y="450" width="500" height="20" rx="10" fill="#e3e9f2"/></svg>`);
  const state = {
    battery: { hasBattery: true, percent: 41, charging: false },
    volume: { level: 40, mute: true },
    brightness: 68,
    wifi: { connected: true, ssid: 'PTCL-5G', hasWlan: true },
    stats: { cpu: 23, ramUsedGB: 6.1, ramTotalGB: 16, diskFreeGB: 212 },
    weather: { temp: 30, icon: 'moon', place: 'Korangi', tomorrowFeels: 39, humid: true, units: 'C' },
    screenTime: { totalMs: (4 * 60 + 17) * 60000, top: [{ name: 'Chrome', ms: 3 * 3600000 }, { name: 'WhatsApp', ms: 1.2 * 3600000 }] },
    nowPlaying: { title: 'Ocean Eyes', source: 'Spotify • Billie Eilish' },
    powerPlan: 'Balanced',
    windows: [],
  };
  const recents = [
    { hwnd: 1, title: 'YouTube - Google Chrome', app: 'Google Chrome', icon: app('Google Chrome').icon, width: 1200, height: 1290, thumb: thumb('#fff') },
    { hwnd: 2, title: 'Documents - File Explorer', app: 'File Explorer', icon: app('File Explorer').icon, width: 1200, height: 1290, thumb: thumb('#fbfcfe') },
    { hwnd: 3, title: 'Windows PowerShell', app: 'Terminal', icon: app('Terminal').icon, width: 1200, height: 1290, thumb: null },
  ];
  const dockModel = () => ({
    mode: q.get('dock') || 'home',
    pinned: config.pinned.map(app).filter(Boolean).map((a, i) => ({ kind: 'app', ...a, running: i === 1 || i === 2 })),
    recent: ['YouTube', 'WhatsApp', 'Gemini'].map(app).map((a) => ({ kind: 'app', ...a, running: a.name === 'WhatsApp' })),
  });
  const log = (name) => (...args) => { console.log('[mock]', name, ...args); return Promise.resolve(null); };

  window.oneshell = {
    getConfig: () => Promise.resolve(config),
    setConfig: (patch) => { config = { ...config, ...patch }; emit('config', config); return Promise.resolve(config); },
    getState: () => Promise.resolve(state),
    getDock: () => Promise.resolve(dockModel()),
    listApps: () => Promise.resolve(apps),
    pin: (id, pin) => { config.pinned = config.pinned.filter((x) => x !== id).concat(pin ? [id] : []); emit('config', config); emit('dock', dockModel()); return Promise.resolve(); },
    showOverlay: (mode, extra) => { emit('overlay', { mode, recents, ...extra }); return Promise.resolve(); },
    hideOverlay: () => { emit('overlay', { mode: null }); return Promise.resolve(); },
    optimize: () => Promise.resolve({ freedMB: 512 }),
    pickImage: () => Promise.resolve(null),
    windowsWallpaper: () => Promise.resolve(null),
    dockMouse: () => {},
    onConfig: on('config'), onState: on('state'), onDock: on('dock'), onOverlay: on('overlay'), onSettingsSection: on('settings:section'),
  };
  for (const name of ['launch', 'openFromDock', 'activate', 'closeWindow', 'closeAll', 'split', 'popup', 'nav', 'setVolume',
    'setBrightness', 'media', 'quickToggle', 'power', 'openSettings', 'openUri', 'closeSelf', 'minimizeSelf', 'maximizeSelf', 'quit']) {
    window.oneshell[name] = log(name);
  }
  const mode = q.get('mode');
  if (mode) setTimeout(() => emit('overlay', { mode, recents }), 50);
})();
