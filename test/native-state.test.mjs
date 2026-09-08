import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Bridge } from "../packages/bridge-core/lib/server.mjs";
import {
  init,
  addProject,
  configuration,
} from "../packages/bridge-core/lib/admin.mjs";
import { recover } from "../packages/bridge-core/lib/cli.mjs";
import { Store } from "../packages/bridge-core/lib/store.mjs";
import { Fault } from "../packages/bridge-core/lib/errors.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "remotedesk-native-state-"));
  const state = join(root, "state"),
    project = join(root, "project");
  await mkdir(project);
  await init(state, { engine: "codex" });
  await addProject(state, { id: "p", path: project });
  const config = await configuration(state);
  config.port = 0;
  config.coordinationDirectory = join(root, "coordination");
  await writeFile(join(state, "config.json"), JSON.stringify(config));
  const adapter = {
    running: false,
    bind(core) {
      this.core = core;
    },
    async quiescent(s) {
      if (this.running || this.core.storage.get("nativeActivity", s.id))
        throw new Fault("TURN_NOT_QUIESCENT");
    },
    async close() {},
  };
  const bridge = new Bridge(state, adapter);
  await bridge.start();
  const s = { id: "native-session", project: "p", title: "Fixture" };
  bridge.store.put("session", s.id, s);
  return {
    root,
    state,
    config,
    bridge,
    adapter,
    s,
    async close() {
      adapter.running = false;
      bridge.store.delete("nativeActivity", s.id);
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("background continuation reuses only its verified writer lock and stale idle cannot unlock running work", async () => {
  const t = await setup();
  try {
    await t.bridge.projectLocks.acquire(t.config.projects[0], t.s.id);
    const original = t.bridge.projectLocks.held.get(t.s.id).value.nonce;
    t.bridge.store.put("nativeActivity", t.s.id, { id: t.s.id, project: "p" });
    await t.adapter.core.claimActivity(
      t.s,
      () => {},
      () => {
        t.adapter.running = true;
      },
    );
    assert.equal(t.bridge.projectLocks.held.get(t.s.id).value.nonce, original);
    t.bridge.emit(t.s.id, { type: "execution.idle" });
    await delay(25);
    assert.equal(t.bridge.projectLocks.held.has(t.s.id), true);
    t.adapter.running = false;
    t.bridge.store.delete("nativeActivity", t.s.id);
    t.bridge.emit(t.s.id, { type: "execution.idle" });
    await delay(25);
    assert.equal(t.bridge.projectLocks.held.has(t.s.id), false);
  } finally {
    await t.close();
  }
});
test("authorization lost after acquiring a fresh continuation lock releases it before dispatch", async () => {
  const t = await setup();
  let checks = 0,
    dispatched = false;
  try {
    await assert.rejects(
      t.adapter.core.claimActivity(
        t.s,
        () => {
          if (++checks === 2) throw new Fault("LEASE_EXPIRED");
        },
        () => {
          dispatched = true;
        },
      ),
      /LEASE_EXPIRED/,
    );
    assert.equal(dispatched, false);
    assert.equal(t.bridge.projectLocks.held.has(t.s.id), false);
    await t.bridge.projectLocks.acquire(t.config.projects[0], "next-session");
    await t.bridge.projectLocks.release("next-session");
  } finally {
    await t.close();
  }
});
test("same-session lock reuse rejects an on-disk nonce change", async () => {
  const t = await setup();
  let held;
  try {
    await t.bridge.projectLocks.acquire(t.config.projects[0], t.s.id);
    held = t.bridge.projectLocks.held.get(t.s.id);
    await writeFile(
      held.path,
      JSON.stringify({ ...held.value, nonce: "replacement" }),
    );
    await assert.rejects(
      t.bridge.projectLocks.acquire(t.config.projects[0], t.s.id),
      /PROJECT_LOCK_OWNER_CHANGED/,
    );
  } finally {
    if (held) await writeFile(held.path, JSON.stringify(held.value));
    await t.close();
  }
});
test("recovery retains uncertain native work until the exact host cleanup acknowledgement", async () => {
  const t = await setup();
  let store;
  try {
    await t.bridge.stop();
    const { stdout } = await promisify(execFile)(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    const lock = join(t.state, "server.lock");
    await writeFile(lock, JSON.stringify({ pid: Number(stdout) }));
    store = new Store(t.state);
    store.put("nativeActivity", t.s.id, {
      id: t.s.id,
      project: "p",
      upstream: "owned-native-thread",
      started: 1,
    });
    await assert.rejects(
      recover(t.state),
      /NATIVE_ACTIVITY_RECONCILIATION_REQUIRED/,
    );
    await access(lock);
    const before = await recover(t.state, { inspect: true });
    assert.equal(before.recovered, false);
    store.put("nativeActivity", t.s.id, {
      id: t.s.id,
      project: "p",
      upstream: "owned-native-thread",
      started: 2,
    });
    await assert.rejects(
      recover(t.state, { confirmNativeCleanup: before.acknowledgement }),
      /NATIVE_ACTIVITY_RECONCILIATION_REQUIRED/,
    );
    await access(lock);
    const current = await recover(t.state, { inspect: true });
    const done = await recover(t.state, {
      confirmNativeCleanup: current.acknowledgement,
    });
    assert.equal(done.nativeCleanupConfirmed, true);
    assert.equal(store.all("nativeActivity").length, 0);
    assert.equal(store.all("nativeRecovery").length, 1);
    await assert.rejects(access(lock));
  } finally {
    store?.close();
    await rm(t.root, { recursive: true, force: true });
  }
});
