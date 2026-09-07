import https from 'node:https';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate, randomUUID } from 'node:crypto';
import { createClientIdentity } from './pki.mjs';
import { fields, requireThat, Fault } from './errors.mjs';
import { privateDirectory } from './privacy.mjs';
import { Store } from './store.mjs';
export class Client {
  constructor({ url, ca, cert, key, servername }) {
    const endpoint = new URL(url);
    requireThat(
      endpoint.protocol === 'https:' &&
        !endpoint.username &&
        !endpoint.password &&
        endpoint.pathname === '/' &&
        !endpoint.search &&
        !endpoint.hash,
      'HTTPS_ENDPOINT_REQUIRED',
    );
    this.url = endpoint;
    this.tls = {
      ca,
      cert,
      key,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true,
      ...(servername ? { servername } : {}),
      agent: false,
    };
  }
  request(path, body, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        new URL(path, this.url),
        {
          ...this.tls,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
          },
          signal,
        },
        (res) => {
          let bytes = 0;
          const chunks = [];
          res.on('data', (c) => {
            bytes += c.length;
            if (bytes > 16000000) {
              req.destroy(new Fault('RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(c);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode !== 200 || value.error)
                throw new Fault(value.error ?? 'HTTP_FAILURE');
              resolve(value);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.setTimeout(60000, () => req.destroy(new Fault('TIMEOUT_RECONCILE')));
      req.on('error', reject);
      req.end(data);
    });
  }
  async read(method, params = {}) {
    return (await this.request('/v1/rpc', { method, params })).result;
  }
  async write(method, params, { operationId, epoch }) {
    requireThat(operationId && epoch, 'OPERATION_ID_AND_EPOCH_REQUIRED');
    return (await this.request('/v1/rpc', { method, params, operationId, epoch })).operation;
  }
  events({ cursor, runtime, signal, onEvent }) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        new URL(`/v1/events?cursor=${cursor}&runtime=${encodeURIComponent(runtime)}`, this.url),
        { ...this.tls, signal },
        (res) => {
          if (res.statusCode !== 200) {
            let b = '';
            res.on('data', (c) => {
              if (b.length < 2000) b += c;
            });
            res.on('end', () => {
              try {
                reject(new Fault(JSON.parse(b).error));
              } catch (e) {
                reject(e);
              }
            });
            return;
          }
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            if (buffer.length > 1000000) {
              req.destroy(new Fault('STREAM_FRAME_TOO_LARGE'));
              return;
            }
            for (let i; (i = buffer.indexOf('\n\n')) >= 0; ) {
              const frame = buffer.slice(0, i);
              buffer = buffer.slice(i + 2);
              const line = frame.split('\n').find((l) => l.startsWith('data: '));
              if (line)
                try {
                  onEvent(JSON.parse(line.slice(6)));
                } catch {
                  req.destroy(new Fault('STREAM_CALLBACK_FAILED'));
                  return;
                }
            }
          });
          res.on('end', resolve);
          res.on('error', reject);
        },
      );
      req.setTimeout(45000, () => req.destroy(new Fault('STREAM_TIMEOUT')));
      req.on('error', reject);
    });
  }
}
export async function pairClient(
  directory,
  { url, invite, name = 'RemoteDesk reference client', servername },
) {
  fields(
    invite,
    ['code', 'expires', 'ca', 'serverInstance'],
    ['code', 'expires', 'ca', 'serverInstance'],
  );
  requireThat(invite.expires > Date.now(), 'INVITE_EXPIRED');
  try {
    await access(join(directory, 'client.json'));
    throw new Fault('CLIENT_ALREADY_PAIRED');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const csr = await createClientIdentity(directory);
  const client = new Client({ url, ca: invite.ca, servername });
  const result = await client.request('/v1/pair', { code: invite.code, csr, name });
  requireThat(result.instance === invite.serverInstance, 'SERVER_IDENTITY_MISMATCH');
  await writeFile(join(directory, 'ca.pem'), invite.ca, { mode: 0o600 });
  await writeFile(join(directory, 'client.pem'), result.cert, { mode: 0o600 });
  await writeFile(
    join(directory, 'client.json'),
    JSON.stringify(
      {
        url,
        servername,
        deviceId: result.deviceId,
        instance: result.instance,
        caFingerprint: new X509Certificate(invite.ca).fingerprint256,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  return { deviceId: result.deviceId };
}
export async function loadClient(directory) {
  await privateDirectory(directory);
  const config = JSON.parse(await readFile(join(directory, 'client.json'), 'utf8'));
  const client = new Client({
    ...config,
    ca: await readFile(join(directory, 'ca.pem')),
    cert: await readFile(join(directory, 'client.pem')),
    key: await readFile(join(directory, 'client.key')),
  });
  const handshake = await client.read('handshake', { version: 1 });
  requireThat(
    handshake.instance === config.instance && handshake.deviceId === config.deviceId,
    'SERVER_IDENTITY_MISMATCH',
  );
  return { client, handshake };
}
// Durable reference-client submission. A retry uses the original packet only.
export async function submit(directory, method, params, { retryId } = {}) {
  const { client, handshake } = await loadClient(directory);
  const store = new Store(directory);
  try {
    let packet;
    if (retryId) {
      packet = store.get('submission', retryId);
      requireThat(packet, 'SUBMISSION_NOT_FOUND');
    } else {
      packet = { method, params, operationId: randomUUID(), epoch: handshake.epoch.id };
      store.put('submission', packet.operationId, packet);
    }
    try {
      const operation = await client.write(packet.method, packet.params, packet);
      store.put('receipt', packet.operationId, operation);
      return { operationId: packet.operationId, operation };
    } catch (e) {
      return {
        operationId: packet.operationId,
        status: 'unknown',
        error: e instanceof Fault ? e.code : 'TRANSPORT_FAILURE_RECONCILE',
      };
    }
  } finally {
    store.close();
  }
}
