import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../packages/bridge-core/lib/server.mjs';
import { init, addProject } from '../packages/bridge-core/lib/admin.mjs';
import { CodexAdapter } from '../src/codex-adapter.mjs';
import { Fault } from '../packages/bridge-core/lib/errors.mjs';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function setup(executor) {
  const root = await mkdtemp(join(tmpdir(), 'remotedesk-fence-')),
    state = join(root, 'state'),
    project = join(root, 'project');
  await mkdir(project);
  await init(state, { engine: 'codex' });
  await addProject(state, { id: 'p', path: project });
  const config = JSON.parse(await readFile(join(state, 'config.json')));
  config.port = 0;
  config.coordinationDirectory = join(root, 'coordination');
  await writeFile(join(state, 'config.json'), JSON.stringify(config));
  const adapter = new CodexAdapter({
    executor: { check: async () => {}, recover: async () => {}, ...executor },
  });
  const bridge = new Bridge(state, adapter);
  await bridge.start();
  const s = { id: 'fixture-session', project: 'p', upstream: 'fixture-thread' };
  bridge.store.put('session', s.id, s);
  const reserve = () => {
    const run = {
      turnId: 'fixture-turn',
      controller: new AbortController(),
      ready: Promise.resolve(),
      readyResolve() {},
    };
    run.done = new Promise((r) => {
      run.doneResolve = r;
    });
    adapter.runs.set(s.id, run);
    adapter.turns.set(s.id, run.turnId);
    adapter.aborters.set(s.id, run.controller);
    return run;
  };
  await bridge.projectLocks.acquire(config.projects[0], s.id);
  return {
    adapter,
    bridge,
    s,
    reserve,
    async close() {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test(
  'native completion and cancel wait for the local callback cleanup before releasing the project',
  { timeout: 60000 },
  async () => {
    const cleanup = deferred(),
      entered = deferred();
    const t = await setup({
      run: async () => {
        entered.resolve();
        await cleanup.promise;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    try {
      const run = t.reserve();
      const tool = t.adapter.serverRequest(t.s, 'item/tool/call', {
        threadId: t.s.upstream,
        turnId: run.turnId,
        tool: 'remotedesk_workspace_read',
        arguments: { path: 'fixture' },
      });
      await entered.promise;
      t.adapter.notification(t.s, {
        method: 'turn/completed',
        params: { threadId: t.s.upstream, turn: { id: run.turnId } },
      });
      let cancelled = false;
      const cancel = t.adapter.cancel(t.s).then(() => {
        cancelled = true;
      });
      await delay(20);
      assert.equal(cancelled, false);
      assert.equal(t.bridge.projectLocks.held.has(t.s.id), true);
      cleanup.resolve();
      await tool;
      await cancel;
      await run.finishPromise;
      await delay(20);
      assert.equal(t.bridge.projectLocks.held.has(t.s.id), false);
    } finally {
      cleanup.resolve();
      await t.close();
    }
  },
);
test(
  'unconfirmed cleanup retains the project lock and blocks cancel and later tool execution',
  { timeout: 60000 },
  async () => {
    let executions = 0;
    const t = await setup({
      run: async () => {
        executions++;
        throw new Fault('DOCKER_CLEANUP_UNCONFIRMED');
      },
    });
    try {
      const run = t.reserve(),
        request = {
          threadId: t.s.upstream,
          turnId: run.turnId,
          tool: 'remotedesk_workspace_read',
          arguments: { path: 'fixture' },
        };
      assert.equal((await t.adapter.serverRequest(t.s, 'item/tool/call', request)).success, false);
      assert.equal((await t.adapter.serverRequest(t.s, 'item/tool/call', request)).success, false);
      assert.equal(executions, 1);
      t.adapter.notification(t.s, {
        method: 'turn/completed',
        params: { threadId: t.s.upstream, turn: { id: run.turnId } },
      });
      await assert.rejects(run.finishPromise, /WORKSPACE_CLEANUP_UNCONFIRMED/);
      await assert.rejects(t.adapter.cancel(t.s), /WORKSPACE_CLEANUP_UNCONFIRMED/);
      await assert.rejects(t.bridge.releaseProject(t.s), /TURN_NOT_QUIESCENT/);
      t.bridge.emit(t.s.id, { type: 'execution.idle' });
      await delay(20);
      assert.equal(t.bridge.projectLocks.held.has(t.s.id), true);
      assert.equal(t.adapter.runs.has(t.s.id), true);
    } finally {
      await t.close();
    }
  },
);
test(
  'an old queued idle event cannot release a new turn project lock',
  { timeout: 60000 },
  async () => {
    const t = await setup({ run: async () => ({}) });
    try {
      const blocker = deferred();
      const start = t.bridge.serializeSession(t.s.id, async () => {
        await blocker.promise;
        t.reserve();
      });
      t.bridge.emit(t.s.id, { type: 'execution.idle' });
      blocker.resolve();
      await start;
      await delay(20);
      assert.equal(t.bridge.projectLocks.held.has(t.s.id), true);
    } finally {
      await t.close();
    }
  },
);
