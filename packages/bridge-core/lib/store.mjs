import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Fault } from "./errors.mjs";
export const token = () => randomBytes(32).toString("base64url");
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "bridge.sqlite"));
    if (process.platform !== "win32")
      chmodSync(join(directory, "bridge.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS kv(kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));`);
  }
  recover() {
    for (const op of this.all("operation"))
      if (op.status === "dispatching") {
        op.status = "unknown";
        this.put("operation", op.id, op);
      }
  }
  get(kind, id) {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.value) : undefined;
  }
  put(kind, id, value) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, id, JSON.stringify(value));
  }
  delete(kind, id) {
    this.db.prepare("DELETE FROM kv WHERE kind=? AND id=?").run(kind, id);
  }
  all(kind) {
    return this.db
      .prepare("SELECT value FROM kv WHERE kind=? ORDER BY id")
      .all(kind)
      .map((r) => JSON.parse(r.value));
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  epoch(device) {
    const now = Date.now();
    for (const e of this.all("epoch"))
      if (now > e.expires + 7 * 86400000) {
        this.transaction(() => {
          for (const op of this.all("operation"))
            if (op.epoch === e.id) this.delete("operation", op.id);
          this.delete("epoch", e.id);
        });
      }
    const existing = this.all("epoch").find(
      (e) => e.device === device && e.expires > now + 3600000,
    );
    if (existing) return existing;
    const e = { id: token(), device, expires: now + 86400000 };
    this.put("epoch", e.id, e);
    return e;
  }
  begin(device, epoch, id, fingerprint) {
    return this.transaction(() => {
      const e = this.get("epoch", epoch);
      if (!e || e.device !== device || e.expires < Date.now())
        throw new Fault("EPOCH_EXPIRED_RECONCILE");
      const key = `${device}:${id}`;
      const old = this.get("operation", key);
      if (old) {
        if (old.fingerprint !== fingerprint || old.epoch !== epoch)
          throw new Fault("OPERATION_ID_CONFLICT");
        return { old };
      }
      if (
        this.all("operation").filter((o) => o.epoch === epoch).length >= 10000
      )
        throw new Fault("OPERATION_QUOTA");
      const value = {
        id: key,
        operationId: id,
        device,
        epoch,
        fingerprint,
        status: "dispatching",
        created: Date.now(),
      };
      this.put("operation", key, value);
      return { value };
    });
  }
  close() {
    this.db.close();
  }
}
