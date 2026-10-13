import https from 'node:https';
import { readFile, writeFile, open, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { initializePki, issueClient } from '../bridge-core/lib/pki.mjs';
import { privateDirectory } from '../bridge-core/lib/privacy.mjs';
import { Store } from '../bridge-core/lib/store.mjs';
import { fields, identifier, requireThat, string } from '../bridge-core/lib/errors.mjs';
import { binding, fingerprint, metadata, VERSION } from './policy.mjs';
import { DesktopProvider } from './provider.mjs';

const response = (res, status, value) => { const body = JSON.stringify(value); if (!res.destroyed) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body);
} };
export async function initialize(directory, { listen = '127.0.0.1', port = 9446, serverNames = ['localhost', '127.0.0.1'] } = {}) {
  requireThat(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, 'PORT_INVALID');
  string(listen, 253, /^[a-zA-Z0-9.:-]+$/);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privateDirectory(directory);
  const lock = await open(join(directory, 'initialize.lock'), 'wx', 0o600);
  try {
    try { await readFile(join(directory, 'text-input.json')); throw new Error('ALREADY_INITIALIZED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await initializePki(join(directory, 'pki'), serverNames);
    await writeFile(join(directory, 'text-input.json'), JSON.stringify({ version: VERSION, listen, port, instance: randomUUID(), bindings: [] }), { mode: 0o600, flag: 'wx' });
  } finally { await lock.close(); await unlink(join(directory, 'initialize.lock')); }
}
export async function enroll(directory, descriptor) {
  const target = binding(descriptor);
  const config = JSON.parse(await readFile(join(directory, 'text-input.json'), 'utf8'));
  requireThat(config.version === VERSION && config.bindings.length < 32, 'CONFIG_INVALID');
  requireThat(!config.bindings.some(b => b.id === target.id), 'BINDING_EXISTS');
  config.bindings.push(target); await writeFile(join(directory, 'text-input.json'), JSON.stringify(config), { mode: 0o600 });
}
export async function invitation(directory, bindingIds) {
  const config = JSON.parse(await readFile(join(directory, 'text-input.json'), 'utf8'));
  requireThat(Array.isArray(bindingIds) && bindingIds.length > 0 && bindingIds.length <= 32 &&
    bindingIds.every(id => config.bindings.some(b => b.id === id)), 'BINDING_FORBIDDEN');
  const store = new Store(directory);
  try {
    const code = randomBytes(32).toString('base64url'), expires = Date.now() + 120000;
    for (const old of store.all('textInvite')) store.delete('textInvite', old.id);
    store.put('textInvite', fingerprint(code), { id: fingerprint(code), expires, bindings: [...new Set(bindingIds)] });
    return { code, expires, ca: await readFile(join(directory, 'pki', 'ca.pem'), 'utf8'), serverInstance: config.instance };
  } finally { store.close(); }
}
export function revoke(directory, deviceId) {
  const store = new Store(directory);
  try { const d = store.get('textDevice', deviceId); requireThat(d, 'DEVICE_NOT_FOUND'); d.revoked = true; d.generation++; store.put('textDevice', d.id, d); }
  finally { store.close(); }
}

export function devices(directory) {
  const store = new Store(directory);
  try { return store.all('textDevice').map(d => ({ id: d.id, revoked: d.revoked, expires: d.expires, bindingIds: d.bindings })); }
  finally { store.close(); }
}

/** Dedicated free metadata service. No engine, projects, text injection or AI entitlement exists on this port. */
export class TextInputServer {
  constructor(directory, provider = DesktopProvider.platform()) {
    this.directory = directory; this.provider = provider; this.leases = new Map(); this.live = new Set();
    this.inflight = 0; this.pairBusy = false; this.stopping = false; this.runtime = randomUUID();
  }
  async start() {
    await privateDirectory(this.directory);
    this.lock = await open(join(this.directory, 'text-input-server.lock'), 'wx', 0o600);
    try {
      this.config = JSON.parse(await readFile(join(this.directory, 'text-input.json'), 'utf8'));
      requireThat(this.config.version === VERSION && this.config.bindings.length <= 32, 'CONFIG_INVALID');
      this.config.bindings = this.config.bindings.map(binding);
      this.store = new Store(this.directory);
      this.server = https.createServer({ key: await readFile(join(this.directory, 'pki', 'server.key')),
        cert: await readFile(join(this.directory, 'pki', 'server.pem')), ca: await readFile(join(this.directory, 'pki', 'ca.pem')),
        requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      (req, res) => { void this.route(req, res); });
      this.server.headersTimeout = 5000; this.server.requestTimeout = 5000; this.server.maxHeadersCount = 32;
      this.server.on('connection', socket => { this.live.add(socket); socket.on('close', () => this.live.delete(socket)); });
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.listen, resolve); });
      return this.server.address();
    } catch (error) { await this.stop(); throw error; }
  }
  authorize(req) {
    requireThat(req.socket.authorized, 'DEVICE_UNAUTHORIZED');
    const fp = req.socket.getPeerCertificate().fingerprint256;
    const d = this.store.all('textDevice').find(value => value.fingerprint === fp);
    requireThat(d && !d.revoked && d.expires > Date.now(), 'DEVICE_UNAUTHORIZED'); return d;
  }
  current(d) {
    requireThat(!this.stopping, 'SERVICE_STOPPING');
    const now = this.store.get('textDevice', d.id);
    requireThat(!this.stopping && now && !now.revoked && now.expires > Date.now() && now.generation === d.generation, 'DEVICE_REVOKED');
  }
  async body(req) {
    requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 'CONTENT_TYPE_INVALID');
    let size = 0, text = ''; for await (const chunk of req) { size += chunk.length; requireThat(size <= 20000, 'REQUEST_TOO_LARGE'); text += chunk; }
    return JSON.parse(text);
  }
  async route(req, res) {
    let admitted = false;
    try {
      requireThat(!this.stopping && this.inflight < 16, 'REQUEST_LIMIT'); this.inflight++; admitted = true;
      requireThat(!req.headers.origin && !req.headers['sec-fetch-site'], 'BROWSER_ORIGIN_REJECTED');
      requireThat(req.method === 'POST', 'ROUTE_NOT_FOUND');
      if (req.url === '/v1/text-input/pair') return response(res, 200, await this.pair(await this.body(req)));
      const d = this.authorize(req); const body = await this.body(req); this.current(d);
      if (req.url === '/v1/text-input/handshake') {
        fields(body, ['version', 'instance', 'deviceId'], ['version', 'instance', 'deviceId']);
        requireThat(body.version === VERSION && body.instance === this.config.instance && body.deviceId === d.id, 'IDENTITY_MISMATCH');
        return response(res, 200, { version: VERSION, instance: this.config.instance, deviceId: d.id,
          capabilities: { editable: true, geometry: true, coordinates: 'capturePhysicalPx' } });
      }
      if (req.url === '/v1/text-input/bind') return response(res, 200, this.bind(d, body));
      requireThat(req.url === '/v1/text-input/snapshot', 'ROUTE_NOT_FOUND');
      fields(body, ['version', 'lease', 'ownerNonce'], ['version', 'lease', 'ownerNonce']);
      string(body.lease, 100); string(body.ownerNonce, 100);
      const lease = this.leases.get(body.lease);
      requireThat(body.version === VERSION && lease && lease.device === d.id && lease.deviceGeneration === d.generation &&
        lease.ownerNonce === body.ownerNonce && lease.expires > performance.now(), 'LEASE_EXPIRED');
      const raw = await this.provider.read(); this.current(d);
      requireThat(lease.expires > performance.now() && this.leases.get(body.lease) === lease, 'LEASE_EXPIRED');
      const result = metadata(raw, lease.binding, this.runtime);
      return response(res, 200, { version: VERSION, runtime: this.runtime, bindingId: lease.binding.id,
        desktopBinding: lease.binding.desktopId, protocolSessionId: lease.binding.protocolSessionId, displayId: lease.binding.displayId,
        frameWidth: lease.binding.outputFrame.width, frameHeight: lease.binding.outputFrame.height, ownerNonce: lease.ownerNonce,
        sequence: ++lease.sequence, ...result });
    } catch (error) { response(res, 400, { error: /^[A-Z0-9_]+$/.test(error.code || error.message) ? error.code || error.message : 'REQUEST_FAILED' }); }
    finally { if (admitted) this.inflight--; }
  }
  async pair(body) {
    fields(body, ['code', 'csr', 'name'], ['code', 'csr', 'name']); string(body.code, 100); string(body.name, 100);
    requireThat(!this.pairBusy, 'PAIR_BUSY'); this.pairBusy = true;
    try {
      const id = fingerprint(body.code), invite = this.store.get('textInvite', id);
      requireThat(invite && invite.expires > Date.now(), 'PAIR_INVALID_OR_EXPIRED');
      requireThat(this.store.all('textDevice').filter(d => !d.revoked).length < 16, 'DEVICE_LIMIT');
      this.store.delete('textInvite', id);
      const cert = await issueClient(join(this.directory, 'pki'), body.csr);
      requireThat(!this.stopping, 'SERVICE_STOPPING');
      const d = { id: randomUUID(), fingerprint: cert.fingerprint, expires: cert.expires,
        generation: 1, revoked: false, bindings: invite.bindings };
      this.store.put('textDevice', d.id, d); return { deviceId: d.id, cert: cert.cert, instance: this.config.instance };
    } finally { this.pairBusy = false; }
  }
  bind(d, body) {
    fields(body, ['version', 'protocol', 'connectionKey', 'ownerNonce', 'displayId', 'frameWidth', 'frameHeight', 'protocolSessionId'],
      ['version', 'protocol', 'connectionKey', 'ownerNonce', 'displayId', 'frameWidth', 'frameHeight', 'protocolSessionId']);
    requireThat(body.version === VERSION, 'VERSION_UNSUPPORTED'); string(body.ownerNonce, 100, /^[A-Za-z0-9_-]+$/);
    const target = this.config.bindings.find(value => d.bindings.includes(value.id) && value.protocol === body.protocol &&
      value.connectionKey === body.connectionKey && value.protocolSessionId === body.protocolSessionId && value.displayId === body.displayId &&
      value.outputFrame.width === body.frameWidth && value.outputFrame.height === body.frameHeight);
    requireThat(target, 'CAPTURE_BINDING_MISMATCH');
    for (const [id, lease] of this.leases) if (lease.expires <= performance.now() || (lease.device === d.id && lease.ownerNonce === body.ownerNonce)) this.leases.delete(id);
    requireThat(this.leases.size < 32 && [...this.leases.values()].filter(lease => lease.device === d.id).length < 8, 'LEASE_LIMIT');
    const id = randomBytes(32).toString('base64url');
    this.leases.set(id, { device: d.id, deviceGeneration: d.generation, binding: target,
      ownerNonce: body.ownerNonce, expires: performance.now() + 15000, sequence: 0 });
    return { version: VERSION, runtime: this.runtime, instance: this.config.instance, deviceId: d.id,
      lease: id, ttlMs: 15000, desktopBinding: target.desktopId, bindingId: target.id };
  }
  async stop() {
    this.stopping = true; this.leases.clear(); this.provider.close();
    for (const socket of this.live) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    // Route continuations recheck stopping before touching the store.
    if (this.store) this.store.close();
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(join(this.directory, 'text-input-server.lock')); }
  }
}
