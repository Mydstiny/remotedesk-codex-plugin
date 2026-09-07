import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Codex App Server uses one JSON object per line (without a JSON-RPC version).
// This internal transport is not an authenticated network API.
export class StdioRpc extends EventEmitter {
  #child;
  #buffer = Buffer.alloc(0);
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #exited;
  #maxFrameBytes;
  #maxPending;
  #timeoutMs;
  #killTimer;

  constructor(command, args = [], { cwd, timeoutMs = 15000, maxFrameBytes = 1048576, maxPending = 32 } = {}) {
    super();
    if (![timeoutMs, maxFrameBytes, maxPending].every(v => Number.isSafeInteger(v) && v > 0)) {
      throw new BridgeError('INVALID_LIMIT');
    }
    this.#maxFrameBytes = maxFrameBytes;
    this.#maxPending = maxPending;
    this.#timeoutMs = timeoutMs;
    this.#child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.#exited = new Promise(resolve => this.#child.once('close', () => {
      clearTimeout(this.#killTimer);
      this.#fail('PROCESS_CLOSED');
      resolve();
    }));
    this.#child.once('error', () => this.#fail('PROCESS_START_FAILED'));
    this.#child.stdin.on('error', () => this.#fail('TRANSPORT_WRITE_FAILED'));
    this.#child.stdout.on('error', () => this.#fail('TRANSPORT_READ_FAILED'));
    this.#child.stdout.on('data', chunk => this.#consume(chunk));
  }

  #fail(code) {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new BridgeError(code));
    }
    this.#pending.clear();
    this.#child.stdin.destroy();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill('SIGTERM');
      this.#killTimer = setTimeout(() => this.#child.kill('SIGKILL'), 1000);
      this.#killTimer.unref();
    }
  }

  #consume(chunk) {
    if (this.#closed) return;
    // Process one frame at a time; many small frames in one chunk are valid.
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      if (this.#buffer.length + i - start > this.#maxFrameBytes) return this.#fail('FRAME_TOO_LARGE');
      const line = Buffer.concat([this.#buffer, chunk.subarray(start, i)]);
      this.#buffer = Buffer.alloc(0);
      start = i + 1;
      if (!line.length) continue;
      let message;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { return this.#fail('INVALID_FRAME'); }
      try { this.#receive(message); }
      catch { return this.#fail('FRAME_DISPATCH_FAILED'); }
      if (this.#closed) return;
    }
    if (this.#buffer.length + chunk.length - start > this.#maxFrameBytes) return this.#fail('FRAME_TOO_LARGE');
    this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(start)]);
  }

  #receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return this.#fail('INVALID_FRAME');
    const hasId = Object.hasOwn(message, 'id');
    if (typeof message.method === 'string') {
      if (hasId) {
        if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) return this.#fail('INVALID_FRAME');
        // AI0 has no approval UI. Unknown requests can never become grants.
        this.#write({ id: message.id, error: { code: -32601, message: 'RemoteDesk probe does not handle server requests' } });
        this.emit('serverRequestRejected', { method: message.method });
      } else {
        this.emit('notification', message);
      }
      return;
    }
    if (!hasId || !Number.isSafeInteger(message.id) ||
        Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) return this.#fail('INVALID_FRAME');
    const pending = this.#pending.get(message.id);
    if (!pending) return this.#fail('UNEXPECTED_RESPONSE');
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) pending.reject(new BridgeError('UPSTREAM_REQUEST_FAILED'));
    else pending.resolve(message.result);
  }

  #write(message) {
    if (this.#closed) throw new BridgeError('TRANSPORT_CLOSED');
    const encoded = Buffer.from(JSON.stringify(message) + '\n');
    if (encoded.length - 1 > this.#maxFrameBytes) throw new BridgeError('FRAME_TOO_LARGE');
    // Bound the writable queue as well as the pending request map.
    if (this.#child.stdin.writableLength + encoded.length > this.#maxFrameBytes * 2) {
      this.#fail('WRITE_QUEUE_FULL');
      throw new BridgeError('WRITE_QUEUE_FULL');
    }
    this.#child.stdin.write(encoded);
  }

  request(method, params = {}) {
    if (this.#closed) return Promise.reject(new BridgeError('TRANSPORT_CLOSED'));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(new BridgeError('TOO_MANY_REQUESTS'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // A timeout is an unknown outcome: terminate, reject all, never retry.
      const timer = setTimeout(() => this.#fail('REQUEST_TIMEOUT_RECONCILE'), this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.#write({ method, params }); }
  async close() { this.#fail('TRANSPORT_CLOSED'); await this.#exited; }
}
