import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../packages/bridge-core/lib/server.mjs';
import { init, addProject, invite, revoke } from '../packages/bridge-core/lib/admin.mjs';
import { pairClient, loadClient, Client } from '../packages/bridge-core/lib/client.mjs';
import { Store } from '../packages/bridge-core/lib/store.mjs';
import { ProjectLocks } from '../packages/bridge-core/lib/project-lock.mjs';
import { serviceDefinition } from '../packages/bridge-core/lib/service.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'remotedesk-security-')),
    state = join(root, 'state'),
    project = join(root, 'project');
  await mkdir(project);
  await init(state, { engine: 'codex' });
  await addProject(state, { id: 'p', path: project });
  const config = JSON.parse(await readFile(join(state, 'config.json')));
  config.port = 0;
  config.coordinationDirectory = join(root, 'coordination');
  await writeFile(join(state, 'config.json'), JSON.stringify(config));
  const adapter = {
    capabilities: {},
    bind(c) {
      this.core = c;
    },
    async create() {
      return {};
    },
    async resume() {},
    async read() {
      return { status: 'idle' };
    },
    async start() {
      return {};
    },
    async cancel() {},
    async close() {},
    validateAnswer() {},
    async deactivate() {},
  };
  const bridge = new Bridge(state, adapter);
  const { address } = await bridge.start(),
    url = `https://127.0.0.1:${address.port}`;
  const inv = await invite(state, { projects: ['p'] });
  await pairClient(join(root, 'client'), { url, invite: inv });
  const { client, handshake } = await loadClient(join(root, 'client'));
  const call = (method, params) =>
    client.write(method, params, { operationId: randomUUID(), epoch: handshake.epoch.id });
  return {
    root,
    state,
    project,
    adapter,
    bridge,
    url,
    client,
    handshake,
    call,
    async close() {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test(
  'strict server identity, epoch expiry and lease expiry cannot resurrect old approvals',
  { timeout: 60000 },
  async () => {
    const t = await setup();
    try {
      const ca = await readFile(join(t.state, 'pki', 'ca.pem'));
      await assert.rejects(
        new Client({ url: t.url, ca, servername: 'unlisted.invalid' }).read('project.list'),
      );
      const id = (await t.call('session.create', { projectId: 'p' })).result.sessionId;
      const lease = (await t.call('lease.acquire', { sessionId: id })).result.lease;
      await t.call('turn.start', { sessionId: id, lease, text: 'fixture' });
      const ask = t.adapter.core.ask(id, { kind: 'command' }).catch((e) => e);
      const pending = (await t.client.read('approval.list', { sessionId: id }))[0];
      const db = new Store(t.state);
      const l = db.get('lease', id);
      l.expires = Date.now() - 1;
      db.put('lease', id, l);
      const replacement = (await t.call('lease.acquire', { sessionId: id })).result.lease;
      assert.notEqual(replacement, lease);
      assert.equal((await ask).code, 'APPROVAL_CANCELLED');
      assert.equal(
        (
          await t.call('approval.answer', {
            sessionId: id,
            lease: replacement,
            approvalId: pending.id,
            answer: { decision: 'accept' },
          })
        ).error,
        'APPROVAL_STALE',
      );
      const epoch = db.get('epoch', t.handshake.epoch.id);
      epoch.expires = Date.now() - 1;
      db.put('epoch', epoch.id, epoch);
      await assert.rejects(t.call('session.create', { projectId: 'p' }), /EPOCH_EXPIRED_RECONCILE/);
      db.close();
    } finally {
      await t.close();
    }
  },
);
test(
  'archive resumes, and revocation fences an already admitted asynchronous response',
  { timeout: 60000 },
  async () => {
    const t = await setup();
    try {
      const id = (await t.call('session.create', { projectId: 'p' })).result.sessionId,
        lease = (await t.call('lease.acquire', { sessionId: id })).result.lease;
      assert.equal((await t.call('session.archive', { sessionId: id, lease })).status, 'succeeded');
      assert.equal((await t.call('session.resume', { sessionId: id, lease })).status, 'succeeded');
      let finish;
      const entered = new Promise((r) => {
        t.adapter.read = async () => {
          r();
          await new Promise((done) => {
            finish = done;
          });
          return { secret: 'MUST_NOT_CROSS_AFTER_REVOKE' };
        };
      });
      const read = t.client.read('session.read', { sessionId: id }).catch((e) => e);
      await entered;
      revoke(t.state, t.handshake.deviceId);
      finish();
      assert.equal((await read).code, 'DEVICE_REVOKED');
    } finally {
      await t.close();
    }
  },
);
test('cross-plugin project writer lock excludes overlapping controllers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remotedesk-lock-'));
  try {
    const path = join(root, 'project');
    await mkdir(path);
    const project = { path: await import('node:fs/promises').then((fs) => fs.realpath(path)) };
    const a = new ProjectLocks(join(root, 'locks'), 'codex'),
      b = new ProjectLocks(join(root, 'locks'), 'dsh');
    await a.prepare([project]);
    await b.prepare([project]);
    await a.acquire(project, 'one');
    await assert.rejects(b.acquire(project, 'two'), /PROJECT_BUSY/);
    await a.release('one');
    await b.acquire(project, 'two');
    await b.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('service definitions quote paths and use current-user non-elevated managers', () => {
  const common = {
    engine: 'codex',
    entry: '/app folder/cli.mjs',
    state: '/state folder',
    node: '/node dir/node',
    user: '/test user',
    path: '/bin',
  };
  const mac = serviceDefinition({ ...common, platform: 'darwin' });
  assert.match(mac.text, /<string>\/app folder\/cli.mjs<\/string>/);
  const linux = serviceDefinition({ ...common, platform: 'linux' });
  assert.match(linux.text, /KillMode=control-group/);
  assert.match(linux.text, /ExecStart="\/node dir\/node" "\/app folder\/cli.mjs"/);
  const win = serviceDefinition({
    ...common,
    platform: 'win32',
    userSid: 'S-1-5-21-123-456-789-1001',
  });
  assert.match(win.text, /InteractiveToken/);
  assert.match(win.text, /LeastPrivilege/);
  assert.doesNotMatch(win.text, /HighestAvailable|Password/);
});

test(
  'cancel/archive serialize with a start still restoring its engine',
  { timeout: 60000 },
  async () => {
    const t = await setup();
    try {
      for (const action of ['turn.cancel', 'session.archive']) {
        const id = (await t.call('session.create', { projectId: 'p' })).result.sessionId,
          lease = (await t.call('lease.acquire', { sessionId: id })).result.lease;
        let release,
          enteredResolve,
          running = false;
        const entered = new Promise((r) => (enteredResolve = r));
        t.bridge.live.delete(id);
        t.adapter.resume = async () => {
          enteredResolve();
          await new Promise((r) => (release = r));
        };
        t.adapter.start = async () => {
          running = true;
          return { accepted: true };
        };
        t.adapter.cancel = async () => {
          running = false;
        };
        const start = t.call('turn.start', { sessionId: id, lease, text: 'race' });
        await entered;
        const stop = t.call(action, { sessionId: id, lease });
        await delay(20);
        release();
        assert.equal((await start).status, 'succeeded');
        assert.equal((await stop).status, 'succeeded');
        assert.equal(running, false);
        assert.equal(t.bridge.projectLocks.held.has(id), false);
        if (action === 'session.archive')
          assert.equal(
            (await t.call('turn.start', { sessionId: id, lease, text: 'must fail' })).error,
            'SESSION_ARCHIVED',
          );
      }
    } finally {
      await t.close();
    }
  },
);
