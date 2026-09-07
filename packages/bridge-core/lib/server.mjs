import https from 'node:https';
import { withLifecycleLock } from './lifecycle-lock.mjs';
import { readFile, open, unlink, realpath } from 'node:fs/promises';
import { ProjectLocks } from './project-lock.mjs';
import { privateDirectory } from './privacy.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, token } from './store.mjs';
import { issueClient } from './pki.mjs';
import { configuration, digest, inside } from './admin.mjs';
import { fields, identifier, string, requireThat, Fault } from './errors.mjs';
export { Fault } from './errors.mjs';
const json = (res, status, body) => {
  const data = JSON.stringify(body);
  if (!res.destroyed) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ = new Set([
  'handshake',
  'project.list',
  'session.list',
  'session.read',
  'operation.read',
  'approval.list',
  'diff.read',
]);
const MUTATE = new Set([
  'session.create',
  'session.resume',
  'session.archive',
  'lease.acquire',
  'lease.renew',
  'lease.release',
  'turn.start',
  'turn.steer',
  'turn.cancel',
  'approval.answer',
  'attachment.upload',
]);
export class Bridge {
  constructor(directory, adapter) {
    this.directory = directory;
    this.adapter = adapter;
    this.streams = new Map();
    this.asks = new Map();
    this.owned = new Map();
    this.live = new Set();
    this.pairBusy = false;
    this.stopping = false;
    this.inflight = 0;
    this.deviceInflight = new Map();
    this.requests = new Set();
    this.controls = new Map();
  }
  async start() {
    requireThat(!this.starting && !this.stopping, 'SERVICE_ALREADY_STARTED');
    this.starting = this.startInternal();
    try {
      return await this.starting;
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async startInternal() {
    await privateDirectory(this.directory);
    this.config = await configuration(this.directory);
    requireThat(!this.stopping, 'SERVICE_STOPPING');
    // Exclusive owner file prevents two engine controllers. Never steal a stale lock.
    await withLifecycleLock(this.directory, async () => {
      this.lockPath = join(this.directory, 'server.lock');
      this.lock = await open(this.lockPath, 'wx', 0o600);
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, started: Date.now() }));
    });
    try {
      this.store = new Store(this.directory);
      this.store.recover();
      for (const lease of this.store.all('lease')) this.store.delete('lease', lease.id);
      this.runtime = token();
      this.nextEvent = this.store.get('meta', 'event')?.next ?? 1;
      this.events = this.store.all('event').sort((a, b) => a.cursor - b.cursor);
      this.projectLocks = new ProjectLocks(
        this.config.coordinationDirectory,
        this.store.get('meta', 'instance').id,
      );
      await this.projectLocks.prepare(this.config.projects);
      this.adapter.bind({
        emit: (id, event) => this.emit(id, event),
        ask: (id, request, signal) => this.ask(id, request, signal),
        storage: this.store,
        projects: this.config.projects,
      });
      await this.adapter.prepare?.();
      for (const p of this.config.projects) {
        requireThat((await realpath(p.path)) === p.path, 'PROJECT_PATH_CHANGED');
        requireThat(!inside(p.path, await realpath(this.directory)), 'STATE_PROJECT_OVERLAP');
      }
      const pki = join(this.directory, 'pki');
      this.server = https.createServer(
        {
          key: await readFile(join(pki, 'server.key')),
          cert: await readFile(join(pki, 'server.pem')),
          ca: await readFile(join(pki, 'ca.pem')),
          requestCert: true,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.3',
          maxHeaderSize: 8192,
        },
        (q, s) => {
          const task = this.route(q, s);
          this.requests.add(task);
          void task.finally(() => this.requests.delete(task));
        },
      );
      this.server.maxConnections = 64;
      this.server.requestTimeout = 15000;
      this.server.headersTimeout = 10000;
      this.server.maxRequestsPerSocket = 1000;
      this.server.on('clientError', (_, socket) => socket.destroy());
      requireThat(!this.stopping, 'SERVICE_STOPPING');
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.config.port, this.config.host, resolve);
      });
      this.monitor = setInterval(() => this.fence(), 500);
      this.monitor.unref();
      return { address: this.server.address(), runtime: this.runtime };
    } catch (e) {
      throw e;
    }
  }
  device(req) {
    requireThat(req.socket.authorized, 'DEVICE_UNAUTHORIZED');
    const fp = req.socket.getPeerCertificate().fingerprint256;
    const d = this.store.all('device').find((d) => d.fingerprint === fp);
    requireThat(d && !d.revoked && d.expires > Date.now(), 'DEVICE_UNAUTHORIZED');
    return d;
  }
  current(d) {
    requireThat(d, 'DEVICE_UNAUTHORIZED');
    const now = this.store.get('device', d.id);
    requireThat(
      now && !now.revoked && now.expires > Date.now() && now.generation === d.generation,
      'DEVICE_REVOKED',
    );
    return now;
  }
  project(d, id) {
    identifier(id);
    this.current(d);
    const p = this.config.projects.find((p) => p.id === id);
    requireThat(p && d.projects.includes(id), 'PROJECT_FORBIDDEN');
    return p;
  }
  session(d, id) {
    identifier(id);
    const s = this.store.get('session', id);
    requireThat(s, 'SESSION_NOT_FOUND');
    this.project(d, s.project);
    return s;
  }
  writer(d, s, leaseId) {
    requireThat(d.role === 'operator', 'READ_ONLY_DEVICE');
    this.current(d);
    const l = this.store.get('lease', s.id);
    requireThat(
      l &&
        l.device === d.id &&
        l.generation === d.generation &&
        l.token === leaseId &&
        l.expires > Date.now(),
      'LEASE_REQUIRED',
    );
    return l;
  }
  async body(req) {
    requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 'CONTENT_TYPE');
    let total = 0;
    const chunks = [];
    for await (const c of req) {
      total += c.length;
      requireThat(total <= 800000, 'BODY_TOO_LARGE');
      chunks.push(c);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new Fault('INVALID_JSON');
    }
  }
  async route(req, res) {
    let admitted = false,
      deviceId;
    try {
      requireThat(this.inflight < 32, 'REQUEST_LIMIT');
      this.inflight++;
      admitted = true;
      requireThat(!this.stopping, 'SERVICE_STOPPING');
      // Native protocol only. Web origins and browser forms are never admitted.
      requireThat(!req.headers.origin && !req.headers['sec-fetch-site'], 'BROWSER_ORIGIN_REJECTED');
      if (req.method === 'POST' && req.url === '/v1/pair') {
        return json(res, 200, await this.pair(await this.body(req)));
      }
      const d = this.device(req);
      requireThat((this.deviceInflight.get(d.id) ?? 0) < 8, 'DEVICE_REQUEST_LIMIT');
      deviceId = d.id;
      this.deviceInflight.set(d.id, (this.deviceInflight.get(d.id) ?? 0) + 1);
      if (req.method === 'GET' && req.url?.startsWith('/v1/events?'))
        return this.subscribe(d, req, res);
      requireThat(req.method === 'POST' && req.url === '/v1/rpc', 'ROUTE_NOT_FOUND');
      const call = await this.body(req);
      this.current(d);
      fields(call, ['method', 'params', 'operationId', 'epoch'], ['method', 'params']);
      requireThat(READ.has(call.method) || MUTATE.has(call.method), 'METHOD_UNSUPPORTED');
      if (READ.has(call.method)) {
        const result = await this.read(d, call.method, call.params);
        this.current(d);
        return json(res, 200, { result });
      }
      identifier(call.operationId);
      string(call.epoch, 100);
      requireThat(d.role === 'operator', 'READ_ONLY_DEVICE');
      const started = this.store.begin(
        d.id,
        call.epoch,
        call.operationId,
        digest(JSON.stringify({ method: call.method, params: call.params })),
      );
      if (started.old) {
        this.current(d);
        return json(res, 200, { operation: started.old });
      }
      const op = started.value;
      try {
        op.result = await this.mutate(d, call.method, call.params);
        op.status = 'succeeded';
      } catch (e) {
        op.status = e instanceof Fault ? 'rejected' : 'unknown';
        op.error = e instanceof Fault ? e.code : 'UPSTREAM_OUTCOME_UNKNOWN_RECONCILE';
      }
      this.store.put('operation', op.id, op);
      this.current(d);
      return json(res, 200, { operation: op });
    } catch (e) {
      json(res, e instanceof Fault ? 400 : 500, {
        error: e instanceof Fault ? e.code : 'INTERNAL_FAILURE',
      });
    } finally {
      if (admitted) this.inflight--;
      if (deviceId) this.deviceInflight.set(deviceId, this.deviceInflight.get(deviceId) - 1);
    }
  }
  async pair(body) {
    fields(body, ['code', 'csr', 'name'], ['code', 'csr', 'name']);
    string(body.code, 100);
    string(body.name, 100);
    requireThat(!this.pairBusy, 'PAIR_BUSY');
    this.pairBusy = true;
    try {
      const id = digest(body.code),
        i = this.store.get('invite', id);
      requireThat(i && i.expires > Date.now(), 'PAIR_INVALID_OR_EXPIRED');
      requireThat(this.store.all('device').filter((d) => !d.revoked).length < 16, 'DEVICE_LIMIT');
      this.store.delete('invite', id); // consume before asynchronous signing, including failed CSR
      const identity = await issueClient(join(this.directory, 'pki'), body.csr);
      const d = {
        id: randomUUID(),
        name: body.name,
        fingerprint: identity.fingerprint,
        expires: identity.expires,
        projects: i.projects,
        role: i.role,
        generation: 1,
        revoked: false,
        created: Date.now(),
      };
      this.store.put('device', d.id, d);
      return {
        deviceId: d.id,
        cert: identity.cert,
        instance: this.store.get('meta', 'instance').id,
      };
    } finally {
      this.pairBusy = false;
    }
  }
  async read(d, method, p) {
    this.current(d);
    if (method === 'handshake') {
      fields(p, ['version'], ['version']);
      requireThat(p.version === 1, 'PROTOCOL_VERSION');
      return {
        version: 1,
        engine: this.config.engine,
        capabilities: this.adapter.capabilities,
        instance: this.store.get('meta', 'instance').id,
        runtime: this.runtime,
        epoch: this.store.epoch(d.id),
        deviceId: d.id,
        role: d.role,
      };
    }
    if (method === 'project.list') {
      fields(p, []);
      return this.config.projects
        .filter((p) => d.projects.includes(p.id))
        .map(({ id, title }) => ({ id, title }));
    }
    if (method === 'session.list') {
      fields(p, ['projectId'], ['projectId']);
      this.project(d, p.projectId);
      return this.store
        .all('session')
        .filter((s) => s.project === p.projectId)
        .map(({ id, project, archived, title }) => ({ id, project, archived, title }));
    }
    if (method === 'operation.read') {
      fields(p, ['operationId'], ['operationId']);
      identifier(p.operationId);
      return this.store.get('operation', `${d.id}:${p.operationId}`) ?? { status: 'not_found' };
    }
    fields(p, method === 'session.read' ? ['sessionId', 'cursor'] : ['sessionId'], ['sessionId']);
    const s = this.session(d, p.sessionId);
    if (p.cursor !== undefined) string(p.cursor, 4000);
    if (method === 'approval.list')
      return [...this.asks.values()]
        .filter((a) => a.session === s.id && a.device === d.id)
        .map((a) => ({ id: a.id, request: a.request, expires: a.expires }));
    if (method === 'session.read') {
      const cursor = this.nextEvent - 1;
      const snapshot = await this.adapter.read(s, p);
      return {
        session: { id: s.id, project: s.project, archived: s.archived, title: s.title },
        snapshot,
        cursor,
      };
    }
    if (method === 'diff.read') return this.adapter.diff(s);
  }
  async ensure(s) {
    if (this.live.has(s.id)) return;
    await this.adapter.resume(s);
    this.live.add(s.id);
  }
  async mutate(d, method, p) {
    // Serialize each session's control transitions across resume/lock/dispatch.
    // Approvals and leases stay independent so startup can never block a reply.
    if (
      !['session.resume', 'session.archive', 'turn.start', 'turn.steer', 'turn.cancel'].includes(
        method,
      )
    )
      return this.mutateNow(d, method, p);
    const session = this.session(d, p.sessionId);
    this.writer(d, session, p.lease);
    return this.serializeSession(session.id, () => {
      requireThat(!this.stopping, 'SERVICE_STOPPING');
      return this.mutateNow(d, method, p);
    });
  }
  async serializeSession(id, action) {
    const previous = this.controls.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.controls.set(id, task);
    try {
      return await task;
    } finally {
      if (this.controls.get(id) === task) this.controls.delete(id);
    }
  }
  async releaseProject(s) {
    await this.adapter.quiescent?.(s);
    await this.projectLocks.release(s.id);
  }
  async mutateNow(d, method, p) {
    if (method === 'session.create') {
      fields(p, ['projectId', 'title'], ['projectId']);
      const project = this.project(d, p.projectId);
      requireThat(this.store.all('session').length < 1000, 'SESSION_LIMIT');
      const s = {
        id: randomUUID(),
        project: project.id,
        title: string(p.title ?? 'RemoteDesk session'),
        archived: false,
      };
      this.current(d);
      const data = await this.adapter.create(s, project);
      Object.assign(s, data);
      this.store.put('session', s.id, s);
      this.live.add(s.id);
      return { sessionId: s.id };
    }
    if (method === 'attachment.upload') {
      fields(p, ['projectId', 'mime', 'data'], ['projectId', 'mime', 'data']);
      this.project(d, p.projectId);
      requireThat(['text/plain', 'image/png', 'image/jpeg'].includes(p.mime), 'ATTACHMENT_TYPE');
      string(p.data, 700000, /^[A-Za-z0-9+/]*={0,2}$/);
      const b = Buffer.from(p.data, 'base64');
      requireThat(
        b.toString('base64') === p.data && b.length <= 512000,
        'ATTACHMENT_SIZE_OR_ENCODING',
      );
      if (p.mime === 'image/png')
        requireThat(
          b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
          'ATTACHMENT_TYPE',
        );
      if (p.mime === 'image/jpeg')
        requireThat(b.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')), 'ATTACHMENT_TYPE');
      if (p.mime === 'text/plain') {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(b);
        } catch {
          throw new Fault('ATTACHMENT_ENCODING');
        }
      }
      for (const a of this.store.all('attachment'))
        if (a.expires < Date.now()) this.store.delete('attachment', a.id);
      requireThat(
        this.store.all('attachment').filter((a) => a.device === d.id).length < 20,
        'ATTACHMENT_QUOTA',
      );
      const a = {
        id: randomUUID(),
        device: d.id,
        project: p.projectId,
        mime: p.mime,
        data: p.data,
        expires: Date.now() + 3600000,
      };
      this.store.put('attachment', a.id, a);
      return { attachmentId: a.id };
    }
    const keys = {
      'session.resume': ['sessionId', 'lease'],
      'session.archive': ['sessionId', 'lease'],
      'lease.acquire': ['sessionId'],
      'lease.renew': ['sessionId', 'lease'],
      'lease.release': ['sessionId', 'lease'],
      'turn.start': ['sessionId', 'lease', 'text', 'attachments'],
      'turn.steer': ['sessionId', 'lease', 'text'],
      'turn.cancel': ['sessionId', 'lease'],
      'approval.answer': ['sessionId', 'lease', 'approvalId', 'answer'],
    };
    fields(p, keys[method], ['sessionId']);
    const s = this.session(d, p.sessionId);
    if (method === 'lease.acquire') {
      const old = this.store.get('lease', s.id);
      requireThat(
        !old ||
          old.expires <= Date.now() ||
          (old.device === d.id && old.generation === d.generation),
        'LEASE_BUSY',
      );
      const valid =
        old && old.expires > Date.now() && old.device === d.id && old.generation === d.generation;
      if (!valid) this.cancelAsks(s.id);
      const l = {
        id: s.id,
        device: d.id,
        generation: d.generation,
        token: valid ? old.token : token(),
        expires: Date.now() + 90000,
      };
      this.store.put('lease', s.id, l);
      return { lease: l.token, expires: l.expires };
    }
    const lease = this.writer(d, s, p.lease);
    if (method === 'lease.renew') {
      lease.expires = Date.now() + 90000;
      this.store.put('lease', s.id, lease);
      return { expires: lease.expires };
    }
    if (method === 'lease.release') {
      this.store.delete('lease', s.id);
      this.cancelAsks(s.id);
      return { released: true };
    }
    if (method === 'approval.answer') {
      const a = this.asks.get(p.approvalId);
      requireThat(
        a &&
          a.session === s.id &&
          a.device === d.id &&
          a.generation === d.generation &&
          a.lease === p.lease &&
          a.expires > Date.now(),
        'APPROVAL_STALE',
      );
      this.adapter.validateAnswer(a.request, p.answer);
      a.resolve(p.answer);
      return { answered: true };
    }
    if (method === 'session.archive') {
      await this.adapter.cancel(s);
      await this.adapter.deactivate?.(s);
      this.live.delete(s.id);
      await this.releaseProject(s);
      this.cancelAsks(s.id);
      s.archived = true;
      this.store.put('session', s.id, s);
      return { archived: true };
    }
    if (method === 'session.resume') {
      await this.ensure(s);
      this.writer(d, s, p.lease);
      s.archived = false;
      this.store.put('session', s.id, s);
      return { resumed: true };
    }
    requireThat(!s.archived, 'SESSION_ARCHIVED');
    await this.ensure(s);
    this.writer(d, s, p.lease);
    if (method === 'turn.cancel') {
      await this.adapter.cancel(s);
      await this.releaseProject(s);
      this.cancelAsks(s.id);
      return { cancelRequested: true };
    }
    string(p.text, 128000);
    if (method === 'turn.steer') return this.adapter.steer(s, p.text);
    requireThat(
      !p.attachments || (Array.isArray(p.attachments) && p.attachments.length <= 4),
      'ATTACHMENT_LIMIT',
    );
    const attachments = (p.attachments ?? []).map((id) => {
      const a = this.store.get('attachment', id);
      requireThat(
        a && a.device === d.id && a.project === s.project && a.expires > Date.now(),
        'ATTACHMENT_INVALID',
      );
      return a;
    });
    await this.projectLocks.acquire(this.project(d, s.project), s.id);
    const previous = this.owned.get(s.id),
      owner = { device: d.id, generation: d.generation, lease: p.lease };
    this.owned.set(s.id, owner);
    try {
      this.writer(d, s, p.lease);
      return await this.adapter.start(s, p.text, attachments);
    } catch (e) {
      if (e instanceof Fault) {
        if (this.owned.get(s.id) === owner) {
          if (previous) this.owned.set(s.id, previous);
          else this.owned.delete(s.id);
        }
        await this.releaseProject(s);
      }
      throw e;
    }
  }
  emit(session, event) {
    if (this.stopping) return;
    const s = this.store.get('session', session);
    if (!s) return;
    if (event.type === 'execution.idle')
      void this.serializeSession(session, () => this.releaseProject(s)).catch(() => {});
    let encoded = JSON.stringify(event);
    if (Buffer.byteLength(encoded) > 200000)
      event = { type: 'snapshot.required', reason: 'EVENT_TOO_LARGE' };
    const e = {
      cursor: this.nextEvent++,
      session,
      project: s.project,
      runtime: this.runtime,
      event,
    };
    this.store.transaction(() => {
      this.store.put('event', String(e.cursor).padStart(16, '0'), e);
      this.store.put('meta', 'event', { next: this.nextEvent });
      this.events.push(e);
      while (
        this.events.length > 2000 ||
        Buffer.byteLength(JSON.stringify(this.events)) > 8000000
      ) {
        const old = this.events.shift();
        this.store.delete('event', String(old.cursor).padStart(16, '0'));
      }
    });
    for (const stream of this.streams.values())
      if (stream.device.projects.includes(s.project)) this.sendEvent(stream, e);
  }
  sendEvent(stream, e) {
    const { res, device } = stream;
    try {
      this.current(device);
    } catch {
      res.destroy();
      return;
    }
    if (
      res.writableLength > 1000000 ||
      !res.write(`id: ${e.cursor}\ndata: ${JSON.stringify(e)}\n\n`)
    ) {
      if (res.writableLength > 1000000) res.destroy();
    }
  }
  subscribe(d, req, res) {
    const u = new URL(req.url, 'https://localhost');
    requireThat(
      [...u.searchParams.keys()].every((k) => ['cursor', 'runtime'].includes(k)),
      'INVALID_QUERY',
    );
    const cursor = Number(u.searchParams.get('cursor'));
    requireThat(Number.isSafeInteger(cursor) && cursor >= 0, 'CURSOR_INVALID');
    requireThat(
      u.searchParams.get('runtime') === this.runtime &&
        cursor <= this.nextEvent - 1 &&
        cursor >= (this.events[0]?.cursor ?? this.nextEvent) - 1,
      'RESET_REQUIRED',
    );
    requireThat(
      [...this.streams.values()].filter((s) => s.device.id === d.id).length < 2,
      'STREAM_LIMIT',
    );
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const id = token();
    this.streams.set(id, { device: d, res });
    for (const e of this.events)
      if (e.cursor > cursor && d.projects.includes(e.project))
        this.sendEvent({ res, device: d }, e);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, 15000);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat);
      this.streams.delete(id);
    });
  }
  ask(session, request, signal) {
    const owner = this.owned.get(session),
      s = this.store.get('session', session);
    if (!owner || !s || signal?.aborted) return Promise.reject(new Fault('APPROVAL_UNAVAILABLE'));
    const d = this.store.get('device', owner.device);
    try {
      this.writer(d, s, owner.lease);
    } catch {
      return Promise.reject(new Fault('APPROVAL_UNAVAILABLE'));
    }
    if (this.asks.size >= 32) return Promise.reject(new Fault('APPROVAL_LIMIT'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (answer, error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.asks.delete(id);
        this.emit(session, { type: 'approval.closed', approvalId: id });
        error ? reject(new Fault(error)) : resolve(answer);
      };
      const timer = setTimeout(() => finish(null, 'APPROVAL_EXPIRED'), 300000);
      const abort = () => finish(null, 'APPROVAL_CANCELLED');
      const a = {
        id,
        session,
        request,
        ...owner,
        expires: Date.now() + 300000,
        resolve: (v) => finish(v),
        reject: abort,
      };
      this.asks.set(id, a);
      signal?.addEventListener('abort', abort, { once: true });
      this.emit(session, { type: 'approval.request', approvalId: id, request, expires: a.expires });
    });
  }
  cancelAsks(id) {
    for (const a of [...this.asks.values()]) if (a.session === id) a.reject();
  }
  fence() {
    for (const stream of this.streams.values())
      try {
        this.current(stream.device);
      } catch {
        stream.res.destroy();
      }
    for (const [id, owner] of this.owned) {
      const d = this.store.get('device', owner.device);
      if (!d || d.revoked || d.expires <= Date.now() || d.generation !== owner.generation) {
        this.cancelAsks(id);
        if (!owner.cancelling) {
          owner.cancelling = true;
          const s = this.store.get('session', id);
          void this.serializeSession(id, async () => {
            if (this.owned.get(id) !== owner) return;
            await this.adapter.cancel(s);
            await this.releaseProject(s);
          })
            .then(
              async () => {
                if (this.owned.get(id) === owner) this.owned.delete(id);
              },
              () => {
                owner.cancelling = false;
              },
            )
            .catch(() => {
              owner.cancelling = false;
            });
        }
      }
    }
    for (const a of [...this.asks.values()]) {
      const l = this.store.get('lease', a.session);
      if (!l || l.expires <= Date.now() || l.token !== a.lease) a.reject();
    }
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }
  async finishStop() {
    await this.starting?.catch(() => {});
    clearInterval(this.monitor);
    for (const a of [...this.asks.values()]) a.reject();
    for (const s of this.streams.values()) s.res.destroy();
    if (this.server)
      await new Promise((r) => {
        this.server.close(r);
        this.server.closeAllConnections();
      });
    let failure;
    try {
      await this.adapter.close();
    } catch (e) {
      failure = e;
    }
    await Promise.allSettled([...this.requests]);
    await Promise.allSettled([...this.controls.values()]);
    if (!failure)
      try {
        await this.projectLocks?.close();
      } catch (e) {
        failure = e;
      }
    this.store?.close();
    await this.lock?.close();
    // Preserve both service/writer locks when engine or container quiescence
    // cannot be confirmed. A later dead-process recovery owns their release.
    if (this.lock && !failure) await unlink(this.lockPath);
    if (failure) throw failure;
  }
}
