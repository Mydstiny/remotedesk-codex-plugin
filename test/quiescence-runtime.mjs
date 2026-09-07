// Fault injection at the Docker CLI/cleanup boundary with a real running
// container, real Codex, mTLS and persistent project locks. No paid model.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../packages/bridge-core/lib/server.mjs';
import { init, addProject, configuration, invite } from '../packages/bridge-core/lib/admin.mjs';
import { pairClient, loadClient } from '../packages/bridge-core/lib/client.mjs';
import { Store } from '../packages/bridge-core/lib/store.mjs';
import { DockerExecutor } from '../packages/bridge-core/lib/docker-executor.mjs';
import { Fault } from '../packages/bridge-core/lib/errors.mjs';
import { CodexAdapter } from '../src/codex-adapter.mjs';
import { fixtureProvider } from './local-provider.mjs';
const root = await realpath(await mkdtemp(join(tmpdir(), 'remotedesk-quiescence-'))),
  state = join(root, 'state'),
  workspace = join(root, 'project');
await mkdir(workspace);
let first = true,
  bridge,
  store,
  executor;
const provider = await fixtureProvider(() => {
  if (first) {
    first = false;
    return {
      call: {
        name: 'remotedesk_workspace_exec',
        arguments: { command: 'while :; do date +%s > still-running.txt; sleep 1; done' },
      },
    };
  }
  return { text: 'CLEANUP_FAILURE_OBSERVED' };
});
class FaultingDocker extends DockerExecutor {
  failCleanup = true;
  async docker(args, options) {
    // Simulate loss of the attached client while the daemon continues work.
    if (this.failCleanup && args[0] === 'start')
      return super.docker(['start', args.at(-1)], options);
    return super.docker(args, options);
  }
  async cleanup(name) {
    if (this.failCleanup) throw new Fault('DOCKER_CLEANUP_UNCONFIRMED');
    return super.cleanup(name);
  }
}
const waitFor = async (fn) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('QUIESCENCE_FIXTURE_TIMEOUT');
};
try {
  await init(state, { engine: 'codex' });
  await addProject(state, { id: 'p', path: workspace, image: process.env.REMOTEDESK_TEST_IMAGE });
  const config = await configuration(state);
  config.port = 0;
  config.coordinationDirectory = join(root, 'coordination');
  await writeFile(join(state, 'config.json'), JSON.stringify(config));
  store = new Store(state);
  executor = new FaultingDocker(store);
  bridge = new Bridge(state, new CodexAdapter({ executor, providerOverrides: provider.overrides }));
  const { address } = await bridge.start(),
    directory = join(root, 'client');
  await pairClient(directory, {
    url: `https://127.0.0.1:${address.port}`,
    invite: await invite(state, { projects: ['p'] }),
  });
  const { client, handshake } = await loadClient(directory),
    call = (method, params) =>
      client.write(method, params, { operationId: randomUUID(), epoch: handshake.epoch.id });
  const id = (await call('session.create', { projectId: 'p' })).result.sessionId,
    lease = (await call('lease.acquire', { sessionId: id })).result.lease;
  assert.equal(
    (
      await call('turn.start', {
        sessionId: id,
        lease,
        text: 'Fixture controlled cleanup failure.',
      })
    ).status,
    'succeeded',
  );
  const approval = await waitFor(
    async () => (await client.read('approval.list', { sessionId: id }))[0],
  );
  assert.equal(
    (
      await call('approval.answer', {
        sessionId: id,
        lease,
        approvalId: approval.id,
        answer: { decision: 'accept' },
      })
    ).status,
    'succeeded',
  );
  await waitFor(
    async () =>
      (await client.read('session.read', { sessionId: id })).snapshot.status === 'blocked',
  );
  assert.ok((await readFile(join(workspace, 'still-running.txt'), 'utf8')).trim());
  const container = store.all('container')[0];
  assert.ok(container);
  assert.equal(
    (
      await executor.docker(['inspect', container.id, '--format', '{{.State.Running}}'])
    ).stdout.trim(),
    'true',
  );
  assert.equal(bridge.projectLocks.held.has(id), true);
  assert.notEqual((await call('turn.cancel', { sessionId: id, lease })).status, 'succeeded');
  assert.notEqual(
    (await call('turn.start', { sessionId: id, lease, text: 'must stay blocked' })).status,
    'succeeded',
  );
  assert.equal(bridge.projectLocks.held.has(id), true);
  executor.failCleanup = false;
  await bridge.stop();
  assert.equal(store.all('container').length, 0);
  assert.equal(bridge.projectLocks.held.size, 0);
  await assert.rejects(executor.docker(['inspect', container.id]));
  console.log(
    'PASS real Codex + Docker + mTLS: an unconfirmed running container keeps the writer lock, cancel/new turn stay blocked, confirmed shutdown removes container before unlock.',
  );
} finally {
  if (executor) executor.failCleanup = false;
  await bridge?.stop();
  store?.close();
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
