import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../../packages/bridge-core/lib/store.mjs';
import { ProjectLocks } from '../../packages/bridge-core/lib/project-lock.mjs';
import { DockerExecutor } from '../../packages/bridge-core/lib/docker-executor.mjs';
import { configuration } from '../../packages/bridge-core/lib/admin.mjs';
const state = process.argv[2],
  c = await configuration(state),
  store = new Store(state),
  owner = store.get('meta', 'instance').id,
  locks = new ProjectLocks(c.coordinationDirectory, owner);
await locks.prepare(c.projects);
await writeFile(
  join(state, 'server.lock'),
  JSON.stringify({ pid: process.pid, started: Date.now() }),
  { flag: 'wx', mode: 0o600 },
);
await locks.acquire(c.projects[0], 'crash-session');
await new DockerExecutor(store).run(
  c.projects[0],
  `node -e 'setInterval(()=>require("fs").appendFileSync("alive.txt","."),100)'`,
);
