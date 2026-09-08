import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { quoteWindows } from "./windows/command.mjs";

export class BridgeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
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
  #closeTimer;
  #resolveClose;
  #directExited = false;
  #cleanupStarted = false;
  #stdoutEnded = false;
  #forcedPipeClose = false;
  #requestHandler;
  #serverPending = new Set();

  constructor(
    command,
    args = [],
    {
      cwd,
      timeoutMs = 15000,
      maxFrameBytes = 1048576,
      maxPending = 32,
      requestHandler,
      env,
    } = {},
  ) {
    super();
    if (
      ![timeoutMs, maxFrameBytes, maxPending].every(
        (v) => Number.isSafeInteger(v) && v > 0,
      )
    ) {
      throw new BridgeError("INVALID_LIMIT");
    }
    this.#requestHandler = requestHandler;
    this.#maxFrameBytes = maxFrameBytes;
    this.#maxPending = maxPending;
    this.#timeoutMs = timeoutMs;
    // A dedicated POSIX group owns only this launch and its descendants.
    // This is not a background service: close always signals the whole group.
    const windows = process.platform === "win32";
    const payload = Buffer.from(
      JSON.stringify({
        command,
        commandLine: [command, ...args].map(quoteWindows).join(" "),
      }),
    ).toString("base64");
    this.#child = spawn(
      windows ? "powershell.exe" : command,
      windows
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            fileURLToPath(new URL("./windows/job.ps1", import.meta.url)),
            "-Payload",
            payload,
          ]
        : args,
      {
        cwd,
        env,
        shell: false,
        detached: !windows,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    this.#exited = new Promise((resolve) => {
      this.#resolveClose = resolve;
    });
    this.#child.once("exit", () => {
      this.#directExited = true;
      this.#fail("PROCESS_CLOSED");
    });
    this.#child.once("close", () => {
      this.#directExited = true;
      this.#fail("PROCESS_CLOSED");
      // Pipe closure alone does not prove descendants exited. Keep the group
      // cleanup timer if any owned group member remains.
      if (!this.#groupExists())
        this.#finishClose(
          !this.#forcedPipeClose && (!this.#child.pid || this.#stdoutEnded),
        );
    });
    this.#child.once("error", () => {
      this.#directExited = true;
      this.#fail("PROCESS_START_FAILED");
    });
    this.#child.stdin.on("error", () => this.#fail("TRANSPORT_WRITE_FAILED"));
    this.#child.stdout.on("error", () => this.#fail("TRANSPORT_READ_FAILED"));
    this.#child.stdout.on("end", () => {
      this.#stdoutEnded = true;
    });
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
  }

  #groupExists() {
    if (!this.#child.pid) return false;
    if (process.platform === "win32") return !this.#directExited;
    try {
      process.kill(-this.#child.pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  }

  #signalGroup(signal) {
    if (!this.#child.pid) return;
    try {
      if (process.platform === "win32") this.#child.kill(signal);
      else process.kill(-this.#child.pid, signal);
    } catch {
      /* The bounded close check reports any remaining launch. */
    }
  }

  #finishClose(success) {
    clearTimeout(this.#killTimer);
    clearTimeout(this.#closeTimer);
    this.#resolveClose(success);
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
    if (this.#cleanupStarted) return;
    this.#cleanupStarted = true;
    this.#signalGroup("SIGTERM");
    this.#killTimer = setTimeout(() => {
      this.#signalGroup("SIGKILL");
      this.#closeTimer = setTimeout(() => {
        // Give owned members time to exit and deliver natural EOF. If we must
        // cut the pipe, an escaped descendant may still hold it: never claim
        // confirmed cleanup merely because the original group disappeared.
        this.#forcedPipeClose = !this.#stdoutEnded;
        this.#child.stdout.destroy();
        this.#finishClose(
          this.#directExited && !this.#groupExists() && !this.#forcedPipeClose,
        );
      }, 500);
    }, 1000);
  }

  #consume(chunk) {
    if (this.#closed) return;
    // Process one frame at a time; many small frames in one chunk are valid.
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      if (this.#buffer.length + i - start > this.#maxFrameBytes)
        return this.#fail("FRAME_TOO_LARGE");
      const line = Buffer.concat([this.#buffer, chunk.subarray(start, i)]);
      this.#buffer = Buffer.alloc(0);
      start = i + 1;
      if (!line.length) continue;
      let message;
      try {
        message = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(line),
        );
      } catch {
        return this.#fail("INVALID_FRAME");
      }
      try {
        this.#receive(message);
      } catch {
        return this.#fail("FRAME_DISPATCH_FAILED");
      }
      if (this.#closed) return;
    }
    if (this.#buffer.length + chunk.length - start > this.#maxFrameBytes)
      return this.#fail("FRAME_TOO_LARGE");
    this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(start)]);
  }

  #receive(message) {
    if (!message || typeof message !== "object" || Array.isArray(message))
      return this.#fail("INVALID_FRAME");
    const hasId = Object.hasOwn(message, "id");
    if (typeof message.method === "string") {
      if (hasId) {
        if (
          !(typeof message.id === "string" || Number.isSafeInteger(message.id))
        )
          return this.#fail("INVALID_FRAME");
        if (!this.#requestHandler) {
          this.#write({
            id: message.id,
            error: { code: -32601, message: "Unsupported server request" },
          });
          this.emit("serverRequestRejected", { method: message.method });
        } else {
          if (
            this.#serverPending.has(message.id) ||
            this.#serverPending.size >= this.#maxPending
          )
            return this.#fail("SERVER_REQUEST_LIMIT");
          this.#serverPending.add(message.id);
          Promise.resolve()
            .then(() =>
              this.#requestHandler(message.method, message.params, message.id),
            )
            .then(
              (result) => {
                if (!this.#closed) this.#write({ id: message.id, result });
              },
              () => {
                if (!this.#closed)
                  this.#write({
                    id: message.id,
                    error: {
                      code: -32601,
                      message: "Request denied or unavailable",
                    },
                  });
              },
            )
            .catch(() => this.#fail("SERVER_RESPONSE_FAILED"))
            .finally(() => this.#serverPending.delete(message.id));
        }
      } else {
        this.emit("notification", message);
      }
      return;
    }
    if (
      !hasId ||
      !Number.isSafeInteger(message.id) ||
      Object.hasOwn(message, "result") === Object.hasOwn(message, "error")
    )
      return this.#fail("INVALID_FRAME");
    const pending = this.#pending.get(message.id);
    if (!pending) return this.#fail("UNEXPECTED_RESPONSE");
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, "error")) {
      this.emit("requestDiagnostic", {
        method: pending.method,
        code: message.error?.code,
        message: message.error?.message,
      });
      const error = new BridgeError("UPSTREAM_REQUEST_FAILED");
      error.requestMethod = pending.method;
      error.upstreamCode = message.error?.code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  #write(message) {
    if (this.#closed) throw new BridgeError("TRANSPORT_CLOSED");
    const encoded = Buffer.from(JSON.stringify(message) + "\n");
    if (encoded.length - 1 > this.#maxFrameBytes)
      throw new BridgeError("FRAME_TOO_LARGE");
    // Bound the writable queue as well as the pending request map.
    if (
      this.#child.stdin.writableLength + encoded.length >
      this.#maxFrameBytes * 2
    ) {
      this.#fail("WRITE_QUEUE_FULL");
      throw new BridgeError("WRITE_QUEUE_FULL");
    }
    this.#child.stdin.write(encoded);
  }

  request(method, params = {}) {
    if (this.#closed)
      return Promise.reject(new BridgeError("TRANSPORT_CLOSED"));
    if (this.#pending.size >= this.#maxPending)
      return Promise.reject(new BridgeError("TOO_MANY_REQUESTS"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // A timeout is an unknown outcome: terminate, reject all, never retry.
      const timer = setTimeout(
        () => this.#fail("REQUEST_TIMEOUT_RECONCILE"),
        this.#timeoutMs,
      );
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }
  async close() {
    this.#fail("TRANSPORT_CLOSED");
    if (!(await this.#exited))
      throw new BridgeError("PROCESS_CLEANUP_UNCONFIRMED");
  }
}
