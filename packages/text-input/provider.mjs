import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/** One bounded native process; never launches a shell or prompts for accessibility permission. */
export class DesktopProvider {
  constructor({ executable, args, timeout = 2000 }) {
    this.executable = executable; this.args = args; this.timeout = timeout;
    this.process = null; this.pending = null; this.buffer = ''; this.closed = false;
  }
  static platform() {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'providers');
    if (process.platform === 'darwin') return new DesktopProvider({ executable: '/usr/bin/swift', args: [join(dir, 'macos.swift')], timeout: 15000 });
    if (process.platform === 'win32') return new DesktopProvider({ executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', join(dir, 'windows.ps1')], timeout: 5000 });
    if (process.platform === 'linux') return new DesktopProvider({ executable: 'python3', args: ['-u', join(dir, 'linux.py')] });
    return { async read() { return { available: false, reason: 'unsupported' }; }, close() {} };
  }
  async read() {
    if (this.closed) return { available: false, reason: 'unavailable' };
    if (this.pending) return this.pending.promise;
    if (!this.process) {
      const child = spawn(this.executable, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      this.process = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        if (this.process !== child || this.closed) return;
        this.buffer += data;
        if (Buffer.byteLength(this.buffer) > 8192) return this.fail();
        const end = this.buffer.indexOf('\n');
        if (end < 0) return;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try { this.complete(JSON.parse(line)); } catch { this.fail(); }
      });
      child.stderr.on('data', () => {}); // Native diagnostics may contain process paths; never forward them.
      child.on('error', () => { if (this.process === child) this.fail(); });
      child.on('exit', () => { if (this.process === child) this.fail(); });
    }
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const child = this.process;
    const pending = { promise, resolve, child, timer: null }; this.pending = pending;
    pending.timer = setTimeout(() => { if (this.pending === pending && this.process === child) this.fail(); }, this.timeout);
    child.stdin.write('\n', error => { if (error && this.process === child && this.pending === pending) this.fail(); });
    return promise;
  }
  complete(value) {
    if (!this.pending) return;
    const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(value);
  }
  fail() { const child = this.process; this.process = null; this.buffer = ''; this.complete({ available: false, reason: 'unavailable' }); child?.kill(); }
  close() { this.closed = true; this.fail(); }
}
