import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const moduleUrl = new URL(
  "../packages/bridge-core/lib/service.mjs",
  import.meta.url,
).href;
const { requestStop } = await import(moduleUrl);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "managed stop orders cleanup before exit and preserves the default signal path",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "remotedesk-review-stop-callback-"),
    );
    const children = [];
    const childCode = `
import { watchStopRequests } from ${JSON.stringify(moduleUrl)};
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const state = process.argv[1], mode = process.argv[2];
let releaseCleanup, releaseExit, calls = 0, signals = 0;
const cleanupGate = new Promise(resolve => releaseCleanup = resolve);
const exitGate = new Promise(resolve => releaseExit = resolve);
process.on('message', message => {
  if (message === 'cleanup') releaseCleanup();
  if (message === 'exit') releaseExit();
  if (message === 'register') process.on('SIGTERM', async () => {
    signals++;
    process.send({ phase: 'signal', signals });
    await unlink(join(state, 'server.lock'));
    await exitGate;
    process.exit(0);
  });
});
const callback = mode === 'callback' ? async () => {
  calls++;
  process.send({ phase: 'callback-start', calls });
  await cleanupGate;
  await unlink(join(state, 'server.lock'));
  process.send({ phase: 'cleanup-done' });
  await exitGate;
  process.send({ phase: 'callback-done', calls });
  process.exit(0);
} : undefined;
if (callback) process.on('SIGTERM', () => process.send({ phase: 'unexpected-signal' }));
watchStopRequests(state, callback);
await writeFile(join(state, 'server.lock'), JSON.stringify({ pid: process.pid }));
process.send({ phase: 'ready' });
`;

    async function setup(mode) {
      const state = await mkdtemp(join(root, mode + "-"));
      const events = [];
      let stderr = "";
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", childCode, state, mode],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      child.stderr.on("data", (data) => (stderr += data));
      child.on("message", (message) => events.push(message));
      const exit = once(child, "exit");
      const wait = async (phase) => {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const event = events.find((event) => event.phase === phase);
          if (event) return event;
          assert.equal(child.exitCode, null, stderr);
          await delay(20);
        }
        throw new Error("phase timeout " + phase + " " + stderr);
      };
      await wait("ready");
      return { state, child, events, wait, exit };
    }

    try {
      const callbackCase = await setup("callback");
      let callbackSettled = false;
      const callbackStop = requestStop(callbackCase.state).then(() => {
        callbackSettled = true;
      });
      await callbackCase.wait("callback-start");
      await delay(650);
      assert.equal(callbackSettled, false);
      assert.equal(
        callbackCase.events.filter((event) => event.phase === "callback-start")
          .length,
        1,
      );
      assert.equal(
        callbackCase.events.some(
          (event) => event.phase === "unexpected-signal",
        ),
        false,
      );
      assert.equal(
        JSON.parse(
          await readFile(join(callbackCase.state, "server.lock"), "utf8"),
        ).pid,
        callbackCase.child.pid,
      );
      callbackCase.child.send("cleanup");
      await callbackCase.wait("cleanup-done");
      await delay(450);
      await assert.rejects(access(join(callbackCase.state, "server.lock")), {
        code: "ENOENT",
      });
      assert.equal(
        callbackSettled,
        false,
        "Removing the lock must not acknowledge a live owner",
      );
      callbackCase.child.send("exit");
      await callbackCase.exit;
      await callbackStop;
      assert.equal(callbackSettled, true);

      const defaultCase = await setup("default");
      let defaultSettled = false;
      const defaultStop = requestStop(defaultCase.state).then(() => {
        defaultSettled = true;
      });
      await delay(650);
      assert.equal(
        defaultCase.events.some((event) => event.phase === "signal"),
        false,
      );
      await access(join(defaultCase.state, "stop.request"));
      defaultCase.child.send("register");
      await defaultCase.wait("signal");
      await delay(350);
      assert.equal(defaultSettled, false);
      assert.equal(
        defaultCase.events.filter((event) => event.phase === "signal").length,
        1,
      );
      defaultCase.child.send("exit");
      await defaultCase.exit;
      await defaultStop;
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit").catch(() => {});
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
