import { readFile, writeFile, mkdir, realpath, stat, access } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { privateDirectory } from './privacy.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializePki } from './pki.mjs';
import { Store, token } from './store.mjs';
import { fields, identifier, string, requireThat } from './errors.mjs';
const exec = promisify(execFile);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
export async function init(directory, { engine, hosts = ['localhost', '127.0.0.1'], host = '127.0.0.1', port = 9443 } = {}) {
  requireThat(['codex', 'dsh'].includes(engine));
  try { await access(join(directory, 'config.json')); throw new Error('ALREADY_INITIALIZED'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  requireThat(Number.isInteger(port) && port > 0 && port < 65536);
  string(host, 253, /^[A-Za-z0-9.:-]+$/);
  await privateDirectory(directory,{create:true,empty:true});
  await initializePki(join(directory, 'pki'), hosts);
  const config = { version: 1, engine, host, port, coordinationDirectory:join(homedir(),'.remotedesk','coordination'), projects: [] };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const store = new Store(directory); store.put('meta', 'instance', { id: token(), created: Date.now() }); store.close();
  return { initialized: true, caFile: join(resolve(directory), 'pki', 'ca.pem'), url: `https://${host.includes(':') ? '['+host+']' : host}:${port}` };
}
export async function configuration(directory) { return JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')); }
export async function addProject(directory, input) {
  fields(input, ['id', 'path', 'title', 'provider', 'model', 'image', 'vision'], ['id', 'path']); identifier(input.id);
  const path = await realpath(input.path); requireThat((await stat(path)).isDirectory());
  const state = await realpath(directory); requireThat(!inside(path, state) && !inside(state, path), 'STATE_PROJECT_OVERLAP');
  const c = await configuration(directory); requireThat(!c.projects.some(p => p.id === input.id) && c.projects.length < 32, 'PROJECT_EXISTS_OR_LIMIT');
  const project = { id: input.id, path, title: string(input.title ?? input.id), ...(input.provider ? { provider: string(input.provider) } : {}), ...(input.model ? { model: string(input.model) } : {}) };
  if(input.vision!==undefined){requireThat(typeof input.vision==='boolean');project.vision=input.vision;}
  if (input.image) project.image = string(input.image, 300, /^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/);
  c.projects.push(project); await writeFile(join(directory, 'config.json'), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  return { projectId: input.id, restartRequired: true };
}
export async function invite(directory, { projects, role = 'operator' }) {
  const c = await configuration(directory); requireThat(['viewer','operator'].includes(role));
  requireThat(Array.isArray(projects) && projects.length > 0 && projects.every(id => c.projects.some(p => p.id === id)));
  const store = new Store(directory);
  try {
    requireThat(store.all('device').filter(d => !d.revoked).length < 16, 'DEVICE_LIMIT');
    const code = token(); const id = digest(code); const expires = Date.now() + 120000;
    // At most one outstanding invite; replacement is explicit local action.
    for (const i of store.all('invite')) store.delete('invite', i.id);
    store.put('invite', id, { id, expires, projects: [...new Set(projects)], role });
    return { code, expires, ca: await readFile(join(directory, 'pki', 'ca.pem'), 'utf8'), serverInstance: store.get('meta', 'instance').id };
  } finally { store.close(); }
}
export function revoke(directory, deviceId) {
  const store = new Store(directory);
  try { const d = store.get('device', deviceId); requireThat(d, 'DEVICE_NOT_FOUND'); d.revoked = true; d.generation++; store.put('device', d.id, d); return { revoked: d.id }; }
  finally { store.close(); }
}
export function status(directory) {
  const store = new Store(directory);
  try { return { devices: store.all('device').map(({id,name,projects,role,revoked,generation})=>({id,name,projects,role,revoked,generation})), sessions: store.all('session').map(({id,project,archived})=>({id,project,archived})), operations: store.all('operation').reduce((a,o)=>(a[o.status]=(a[o.status]??0)+1,a),{}) }; }
  finally { store.close(); }
}
