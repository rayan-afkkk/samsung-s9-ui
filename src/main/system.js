// System info for widgets and the status bar: CPU/RAM/disk, Wi-Fi, weather, screen time.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');

// ---------------------------------------------------------------- CPU / RAM / disk
let lastCpu = null;
function cpuPercent() {
  const now = os.cpus().reduce(
    (acc, c) => {
      const t = c.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
  let pct = 0;
  if (lastCpu) {
    const idle = now.idle - lastCpu.idle;
    const total = now.total - lastCpu.total;
    pct = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
  }
  lastCpu = now;
  return pct;
}

async function stats() {
  const total = os.totalmem();
  const used = total - os.freemem();
  let diskFree = null;
  try {
    const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/';
    const s = await fs.promises.statfs(root);
    diskFree = (s.bavail * s.bsize) / 1024 ** 3;
  } catch {}
  return {
    cpu: cpuPercent(),
    ramUsedGB: used / 1024 ** 3,
    ramTotalGB: total / 1024 ** 3,
    diskFreeGB: diskFree,
  };
}

// ---------------------------------------------------------------- Wi-Fi
function wifi() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ connected: true, ssid: 'Wi-Fi', wired: false });
    execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      // No WLAN service usually means a wired desktop PC.
      if (err || !out) return resolve({ connected: !!err, ssid: null, wired: !!err });
      const state = /^\s*State\s*:\s*(.+)$/im.exec(out);
      const ssid = /^\s*SSID\s*:\s*(.+)$/im.exec(out);
      const connected = !!state && /connected/i.test(state[1]) && !/disconnected/i.test(state[1]);
      resolve({ connected, ssid: connected && ssid ? ssid[1].trim() : null, wired: false, hasWlan: true });
    });
  });
}

function wifiToggle(currentSsid, lastSsid) {
  return new Promise((resolve) => {
    const args = currentSsid ? ['wlan', 'disconnect'] : ['wlan', 'connect', `name=${lastSsid}`];
    if (!currentSsid && !lastSsid) return resolve(false);
    execFile('netsh', args, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

function powerPlan() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('Balanced');
    execFile('powercfg', ['/getactivescheme'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      const m = !err && /\(([^)]+)\)\s*$/.exec((out || '').trim());
      resolve(m ? m[1] : null);
    });
  });
}

// ---------------------------------------------------------------- weather (Open-Meteo, no API key)
let weatherCache = null;
let weatherAt = 0;

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'OneShell' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function locate(city) {
  if (city) {
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
    const hit = g.results && g.results[0];
    if (hit) return { lat: hit.latitude, lon: hit.longitude, name: hit.name };
  }
  const ip = await getJson('https://ipwho.is/');
  return { lat: ip.latitude, lon: ip.longitude, name: ip.city };
}

function describe(code, isDay) {
  if (code === 0 || code === 1) return isDay ? 'sun' : 'moon';
  if (code === 2) return isDay ? 'sun-cloud' : 'moon-cloud';
  if (code === 3 || code === 45 || code === 48) return 'cloud';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}

async function weather(city, units, force = false) {
  if (!force && weatherCache && Date.now() - weatherAt < 30 * 60 * 1000) return weatherCache;
  try {
    const loc = await locate(city);
    const unit = units === 'F' ? '&temperature_unit=fahrenheit' : '';
    const w = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,apparent_temperature_max` +
        `&timezone=auto&forecast_days=2${unit}`,
    );
    const tomorrowFeels = Math.round(w.daily.apparent_temperature_max[1]);
    const tomorrowMax = Math.round(w.daily.temperature_2m_max[1]);
    weatherCache = {
      temp: Math.round(w.current.temperature_2m),
      icon: describe(w.current.weather_code, w.current.is_day === 1),
      place: loc.name,
      tomorrowFeels,
      humid: tomorrowFeels - tomorrowMax >= 3,
      units: units === 'F' ? 'F' : 'C',
    };
    weatherAt = Date.now();
  } catch (e) {
    console.warn('[weather]', e.message);
  }
  return weatherCache;
}

// ---------------------------------------------------------------- screen time
let usage = null;
let current = null; // { app, since }
const usageFile = () => path.join(app.getPath('userData'), 'screentime.json');
const today = () => new Date().toISOString().slice(0, 10);

function loadUsage() {
  if (usage) return usage;
  try { usage = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch { usage = {}; }
  return usage;
}

function flush() {
  if (current) {
    const u = loadUsage();
    const day = (u[today()] = u[today()] || {});
    day[current.app] = (day[current.app] || 0) + (Date.now() - current.since);
    current.since = Date.now();
  }
  // keep a week
  const keep = Object.keys(usage || {}).sort().slice(-7);
  usage = Object.fromEntries(keep.map((k) => [k, usage[k]]));
  try { fs.writeFileSync(usageFile(), JSON.stringify(usage)); } catch {}
}

function foreground(appName) {
  flush();
  current = appName ? { app: appName, since: Date.now() } : null;
}

function screenTime() {
  flush();
  const day = loadUsage()[today()] || {};
  const entries = Object.entries(day).sort((a, b) => b[1] - a[1]);
  const totalMs = entries.reduce((s, [, ms]) => s + ms, 0);
  return { totalMs, top: entries.slice(0, 2).map(([name, ms]) => ({ name, ms })) };
}

// ---------------------------------------------------------------- now playing (from window titles)
function nowPlaying(windows) {
  for (const w of windows || []) {
    const exe = (w.exe || '').toLowerCase();
    const title = w.title || '';
    if (exe.endsWith('spotify.exe') && title && !/^spotify( premium| free)?$/i.test(title)) {
      const [artist, ...song] = title.split(' - ');
      return { title: song.join(' - ') || title, source: `Spotify • ${song.length ? artist : ''}`.replace(/ • $/, '') };
    }
  }
  for (const w of windows || []) {
    const m = /^(?:\(\d+\) )?(.+) - YouTube(?: Music)?(?: — | - ).+$/.exec(w.title || '');
    if (m) return { title: m[1], source: 'YouTube' };
  }
  return null;
}

module.exports = { stats, wifi, wifiToggle, powerPlan, weather, foreground, screenTime, flush, nowPlaying };
