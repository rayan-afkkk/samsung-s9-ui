const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // Taskbar & navigation
  replaceTaskbar: true,
  replaceStart: true,
  navButtons: false,
  hookWinA: true,
  hookWinTab: true,
  // Wallpaper & style
  wallpaper: null,          // file path; overrides wallpaperPreset
  wallpaperPreset: 'blue',  // built-in wallpaper: blue, sky, ocean, lavender, peach, mint, sunset, night
  accent: '#3e7bfa',
  darkMode: false,
  photos: [null, null, null, null, null, null],
  lockPhoto: null,
  // Home screen
  city: '',                 // empty = detect from IP
  units: 'C',
  showSearch: true,
  pinned: null,             // null = pick defaults on first run
  // Lock screen
  lockOnStartup: true,
  lockOnResume: true,
  // Multi window
  roundedWindows: true,
  // Animations & sounds
  animations: true,
  // About
  autostart: true,
};

let file;
let data;

function load() {
  file = path.join(app.getPath('userData'), 'config.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  // v2: navigation buttons are off by default now; turn them off for existing installs too.
  if ((data.configVersion || 1) < 2) {
    data.navButtons = false;
    data.configVersion = 2;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
  }
  return data;
}

function get() {
  return data || load();
}

function set(patch) {
  data = { ...get(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

module.exports = { load, get, set, DEFAULTS };
