import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../packages/bridge-core/lib/server.mjs';
import { init, addProject, invite, revoke } from '../packages/bridge-core/lib/admin.mjs';
import { Client, pairClient, loadClient } from '../packages/bridge-core/lib/client.mjs';
import { Store } from '../packages/bridge-core/lib/store.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
class Adapter {
  capabilities = { sessions: true, turns: true, approvals: true, fixture: true };
  count = 0;
  cancelled = 0;
  bind(core) {
    this.core = core;
  }
  async create() {
    return {};
  }
  async resume() {}
  async read() {
    return { status: 'idle' };
  }
  async diff() {
    return { diff: '' };
  }
  async start(s, text) {
    this.count++;
    this.core.emit(s.id, { type: 'turn.started', text });
    return { turnId: 'fixture' };
  }
  async steer() {
    return { steered: true };
  }
  validateAnswer(r, a) {
    assert.ok(['accept', 'decline'].includes(a.decision));
  }
  async cancel() {
    this.cancelled++;
  }
  async close() {}
}
test(
  'mTLS pairing, grants, leases, operation recovery, approval fencing and revocation',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'remotedesk-core-test-'));
    const state = join(root, 'state'),
      work = join(root, 'work');
    await mkdir(work);
    const adapter = new Adapter();
    let bridge;
    try {
      await init(state, { engine: 'codex' });
      await addProject(state, { id: 'work', path: work });
      // Port zero is for a test harness only; the admin rejects it for deployment.
      const config = JSON.parse(await readFile(join(state, 'config.json')));
      config.port = 0;
      config.coordinationDirectory = join(root, 'coordination');
      await writeFile(join(state, 'config.json'), JSON.stringify(config));
      bridge = new Bridge(state, adapter);
      const { address } = await bridge.start();
      const url = `https://127.0.0.1:${address.port}`;
      const noCert = new Client({ url, ca: await readFile(join(state, 'pki', 'ca.pem')) });
      await assert.rejects(noCert.read('project.list'), /DEVICE_UNAUTHORIZED/);
      const inv = await invite(state, { projects: ['work'] });
      await pairClient(join(root, 'client'), { url, invite: inv });
      await assert.rejects(
        pairClient(join(root, 'duplicate'), { url, invite: inv }),
        /PAIR_INVALID/,
      );
      const { client, handshake } = await loadClient(join(root, 'client'));
      const call = (method, params, operationId = randomUUID()) =>
        client.write(method, params, { operationId, epoch: handshake.epoch.id });
      assert.deepEqual(await client.read('project.list'), [{ id: 'work', title: 'work' }]);
      assert.equal(
        (await call('session.create', { projectId: 'forbidden' })).error,
        'PROJECT_FORBIDDEN',
      );
      const created = await call('session.create', { projectId: 'work' });
      const id = created.result.sessionId;
      const lease = (await call('lease.acquire', { sessionId: id })).result.lease;
      const params = { sessionId: id, lease, text: 'marker' },
        op = randomUUID();
      assert.equal((await call('turn.start', params, op)).status, 'succeeded');
      assert.equal((await call('turn.start', params, op)).status, 'succeeded');
      assert.equal(adapter.count, 1);
      adapter.core.emit(id, { type: 'turn/completed' });
      await delay(20);
      await assert.rejects(
        call('turn.start', { ...params, text: 'different' }, op),
        /OPERATION_ID_CONFLICT/,
      );
      const viewerInvite = await invite(state, { projects: ['work'], role: 'viewer' });
      await pairClient(join(root, 'viewer'), { url, invite: viewerInvite });
      const viewer = await loadClient(join(root, 'viewer'));
      await assert.rejects(
        viewer.client.write('turn.start', params, {
          operationId: randomUUID(),
          epoch: viewer.handshake.epoch.id,
        }),
        /READ_ONLY_DEVICE/,
      );
      const streamAbort = new AbortController();
      const events = [];
      const streaming = client
        .events({
          cursor: 0,
          runtime: handshake.runtime,
          signal: streamAbort.signal,
          onEvent: (e) => events.push(e),
        })
        .catch((e) => e);
      const request = adapter.core.ask(id, { type: 'command' }, new AbortController().signal);
      await delay(100);
      const pending = await client.read('approval.list', { sessionId: id });
      assert.equal(pending.length, 1);
      assert.equal(
        (
          await call('approval.answer', {
            sessionId: id,
            lease,
            approvalId: pending[0].id,
            answer: { decision: 'decline' },
          })
        ).status,
        'succeeded',
      );
      assert.deepEqual(await request, { decision: 'decline' });
      const oldAsk = adapter.core
        .ask(id, { type: 'command' }, new AbortController().signal)
        .catch((e) => e);
      await delay(20);
      const old = (await client.read('approval.list', { sessionId: id }))[0];
      await call('lease.release', { sessionId: id, lease });
      assert.match((await oldAsk).code, /APPROVAL_CANCELLED/);
      const newLease = (await call('lease.acquire', { sessionId: id })).result.lease;
      assert.equal(
        (
          await call('approval.answer', {
            sessionId: id,
            lease: newLease,
            approvalId: old.id,
            answer: { decision: 'accept' },
          })
        ).error,
        'APPROVAL_STALE',
      );
      assert.ok(events.some((e) => e.event.type === 'turn.started'));
      streamAbort.abort();
      await streaming;
      revoke(state, handshake.deviceId);
      await delay(700);
      await assert.rejects(client.read('project.list'), /DEVICE_UNAUTHORIZED/);
      assert.ok(adapter.cancelled > 0);
      await bridge.stop();
      bridge = null;
      const db = new Store(state);
      const unknownId = randomUUID(),
        ep = db.epoch('fixture');
      db.begin('fixture', ep.id, unknownId, 'x');
      db.close();
      const recover = new Store(state);
      recover.recover();
      assert.equal(recover.get('operation', 'fixture:' + unknownId).status, 'unknown');
      recover.close();
    } finally {
      await bridge?.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test('state must be outside every exposed project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remotedesk-overlap-'));
  try {
    await mkdir(join(root, 'state'));
    await writeFile(join(root, 'state', 'config.json'), '{"projects":[]}');
    await assert.rejects(
      addProject(join(root, 'state'), { id: 'bad', path: root }),
      /STATE_PROJECT_OVERLAP/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
