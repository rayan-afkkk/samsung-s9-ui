// Client for the OneShellNative.exe helper (see src/native/OneShellNative.cs).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { app } = require('electron');

class Native extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.available = false;
  }

  exePath() {
    const candidates = [
      path.join(process.resourcesPath || '', 'native', 'OneShellNative.exe'),
      path.join(app.getAppPath(), 'build', 'native', 'OneShellNative.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p));
  }

  start() {
    const exe = process.platform === 'win32' ? this.exePath() : null;
    if (!exe) {
      console.warn('[native] helper not available, running without Windows integration');
      return;
    }
    const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.available = true;
    // Writing to a helper that just died must never crash the shell.
    proc.stdin.on('error', (err) => console.warn('[native] stdin:', err.message));
    proc.on('error', (err) => console.warn('[native] spawn:', err.message));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => console.warn('[native]', d.trim()));
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.available = false;
      for (const { resolve } of this.pending.values()) resolve(null);
      this.pending.clear();
      if (!this.stopping) {
        console.warn('[native] helper exited with', code, '- restarting');
        setTimeout(() => this.start(), 1000);
      }
    });
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event) {
      this.emit(msg.event, msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  call(cmd, args = {}) {
    const proc = this.proc;
    if (!this.available || !proc || !proc.stdin.writable || proc.stdin.destroyed) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    }).catch((err) => {
      console.warn(`[native] ${cmd} failed:`, err.message);
      return null;
    });
  }

  stop() {
    this.stopping = true;
    if (!this.proc) return;
    // Closing stdin makes the helper restore the taskbar and work area, then exit.
    try { this.proc.stdin.end(); } catch {}
  }
}

module.exports = new Native();
