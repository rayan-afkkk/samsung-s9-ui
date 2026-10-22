// Installed apps (Start menu contents) and launching.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { nativeImage, shell } = require('electron');
const native = require('./native');

const KNOWN_FOLDERS = {
  '{6D809377-6AF0-444B-8957-A3773F02200E}': process.env.ProgramW6432 || process.env.ProgramFiles,
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': process.env['ProgramFiles(x86)'],
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64'),
  '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': process.env.SystemRoot || 'C:\\Windows',
  '{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}': process.env.LOCALAPPDATA,
  '{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}': process.env.APPDATA,
};

const JUNK = /\b(uninstall|uninstaller|readme|read me|help|documentation|website|release notes|license)\b/i;
const JUNK_EXT = /\.(url|txt|chm|pdf|html?|rtf)$/i;

let cache = null;
let loading = null;

function startMenuShortcuts() {
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const byName = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.name.toLowerCase().endsWith('.lnk')) {
        const name = e.name.slice(0, -4).toLowerCase();
        if (!byName.has(name)) byName.set(name, full);
      }
    }
  };
  roots.forEach((r) => walk(r, 0));
  return byName;
}

function resolveKnownFolder(id) {
  const m = /^(\{[0-9A-F-]+\})\\(.+)$/i.exec(id);
  if (m && KNOWN_FOLDERS[m[1].toUpperCase()]) return path.join(KNOWN_FOLDERS[m[1].toUpperCase()], m[2]);
  if (/^[a-z]:\\/i.test(id)) return id;
  return null;
}

function runAppsScript() {
  return new Promise((resolve) => {
    // Scripts inside app.asar can't be read by PowerShell, so pass the source as -EncodedCommand.
    const source = fs.readFileSync(path.join(__dirname, 'apps.ps1'), 'utf8').replace(/^\uFEFF/, '');
    const encoded = Buffer.from(source, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => (out += d));
    ps.on('error', () => resolve([]));
    ps.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]');
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        resolve([]);
      }
    });
  });
}

async function iconFor(app) {
  if (app.logo) {
    const img = nativeImage.createFromPath(app.logo);
    if (!img.isEmpty()) return img.toDataURL();
  }
  const file = app.lnk || app.exe;
  if (file) return native.call('icon', { path: file });
  return null;
}

async function list(force = false) {
  if (cache && !force) return cache;
  if (loading) return loading;
  loading = (async () => {
    if (process.platform !== 'win32') return [];
    const raw = await runAppsScript();
    const lnks = startMenuShortcuts();
    const seen = new Set();
    const apps = [];
    for (const a of raw) {
      if (!a || !a.name || !a.id) continue;
      if (JUNK.test(a.name) || JUNK_EXT.test(a.id)) continue;
      const key = a.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const lnk = lnks.get(key) || null;
      let exe = resolveKnownFolder(a.id);
      if (!exe && lnk) {
        try { exe = shell.readShortcutLink(lnk).target || null; } catch {}
      }
      apps.push({ name: a.name, id: a.id, lnk, exe, logo: a.logo || null, icon: null });
    }
    apps.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
    // Icons in small parallel batches, the helper caches them.
    for (let i = 0; i < apps.length; i += 8) {
      await Promise.all(apps.slice(i, i + 8).map(async (app) => { app.icon = await iconFor(app); }));
    }
    cache = apps;
    loading = null;
    return apps;
  })();
  return loading;
}

function launch(app) {
  if (!app || !app.id) return;
  // shell:AppsFolder handles Store apps, Win32 apps and known-folder paths the same way.
  spawn('explorer.exe', [`shell:AppsFolder\\${app.id}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function openUri(uri) {
  shell.openExternal(uri);
}

const DEFAULT_PINS = [
  ['notes', 'sticky notes', 'onenote', 'notepad'],
  ['file explorer'],
  ['google chrome', 'microsoft edge', 'firefox', 'brave'],
  ['whatsapp', 'telegram', 'messenger', 'phone link'],
  ['terminal', 'windows powershell', 'command prompt'],
  ['visual studio code', 'calculator'],
  ['settings'],
];

function defaultPins(apps) {
  const out = [];
  for (const options of DEFAULT_PINS) {
    const hit = options.map((o) => apps.find((a) => a.name.toLowerCase() === o)).find(Boolean);
    if (hit && !out.includes(hit.id)) out.push(hit.id);
  }
  return out;
}

module.exports = { list, launch, openUri, defaultPins, iconFor };
