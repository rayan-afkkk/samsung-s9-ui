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
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.available = true;
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    this.proc.on('exit', (code) => {
      this.available = false;
      for (const { reject } of this.pending.values()) reject(new Error('helper exited'));
      this.pending.clear();
      if (!this.stopping) {
        console.warn('[native] helper exited with', code, '- restarting');
        setTimeout(() => this.start(), 1000);
        this.emit('restarted');
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
    if (!this.available || !this.proc) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
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
