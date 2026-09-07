// Real daemon survives SIGKILL. Recovery must fail closed and clean containers
// before another plugin can acquire this project's writer lock.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, addProject, configuration } from '../packages/bridge-core/lib/admin.mjs';
import { Store } from '../packages/bridge-core/lib/store.mjs';
import { ProjectLocks } from '../packages/bridge-core/lib/project-lock.mjs';
import { recover } from '../packages/bridge-core/lib/cli.mjs';
import { DockerExecutor } from '../packages/bridge-core/lib/docker-executor.mjs';
assert.notEqual(
  process.platform,
  'win32',
  'This daemon-crash fixture needs POSIX process-group SIGKILL; Windows Docker acceptance is separate.',
);
const exec = promisify(execFile),
  root = await realpath(await mkdtemp(join(tmpdir(), 'remotedesk-recovery-'))),
  state = join(root, 'state'),
  project = join(root, 'project');
await mkdir(project);
let child, db, exited;
const wait = async (fn) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('RECOVERY_FIXTURE_TIMEOUT');
};
try {
  const image =
    process.env.REMOTEDESK_TEST_IMAGE ??
    (
      await exec('docker', [
        'image',
        'inspect',
        'remotedesk-dsh-sandbox:0.2.0',
        '--format',
        '{{.Id}}',
      ])
    ).stdout.trim();
  await init(state, { engine: 'codex' });
  await addProject(state, { id: 'p', path: project, image });
  const c = await configuration(state);
  c.coordinationDirectory = join(root, 'coordination');
  await writeFile(join(state, 'config.json'), JSON.stringify(c));
  db = new Store(state);
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL('fixtures/crash-worker.mjs', import.meta.url)), state],
    { detached: true, stdio: 'ignore' },
  );
  exited = new Promise((r) => child.once('exit', r));
  await wait(async () => {
    try {
      return (await readFile(join(project, 'alive.txt'), 'utf8')).length > 0;
    } catch {
      return false;
    }
  });
  process.kill(-child.pid, 'SIGKILL');
  await exited;
  const container = db.all('container')[0];
  assert.ok(container);
  assert.equal(
    (
      await exec('docker', ['inspect', container.id, '--format', '{{.State.Running}}'])
    ).stdout.trim(),
    'true',
  );
  const mock = join(root, 'mock-bin');
  await mkdir(mock);
  await writeFile(join(mock, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const recoveryModule = new URL('../packages/bridge-core/lib/cli.mjs', import.meta.url).href;
  await assert.rejects(
    exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {recover} from ${JSON.stringify(recoveryModule)};await recover(${JSON.stringify(state)});`,
      ],
      { env: { ...process.env, PATH: mock }, timeout: 15000, maxBuffer: 16000 },
    ),
  );
  await access(join(state, 'server.lock'));
  const other = new ProjectLocks(c.coordinationDirectory, 'other-plugin');
  await other.prepare(c.projects);
  await assert.rejects(other.acquire(c.projects[0], 'other'), /PROJECT_BUSY/);
  assert.equal(db.all('container').length, 1);
  await recover(state);
  await assert.rejects(access(join(state, 'server.lock')));
  assert.equal(db.all('container').length, 0);
  const before = await readFile(join(project, 'alive.txt'), 'utf8');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await readFile(join(project, 'alive.txt'), 'utf8'), before);
  await other.acquire(c.projects[0], 'other');
  await other.close();
  assert.equal(
    (
      await exec('docker', [
        'ps',
        '-aq',
        '--filter',
        'label=org.remotedesk.owner=' + db.get('meta', 'instance').id,
      ])
    ).stdout.trim(),
    '',
  );
  console.log(
    'PASS real daemon crash: failed cleanup retains locks, successful recovery stops writes before cross-plugin unlock, zero owned containers',
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    await exited;
  }
  if (db) {
    await new DockerExecutor(db).recover();
    db.close();
  }
  await rm(root, { recursive: true, force: true });
}
