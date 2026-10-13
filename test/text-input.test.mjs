import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binding, metadata, fingerprint } from '../packages/text-input/policy.mjs';
import { initialize, enroll, invitation, revoke, TextInputServer } from '../packages/text-input/server.mjs';
import { createClientIdentity } from '../packages/bridge-core/lib/pki.mjs';
import { Client } from '../packages/bridge-core/lib/client.mjs';

const descriptor = { id: 'capture', protocol: 'rdp', connectionKey: fingerprint('rdp|test-host|3389'),
  desktopId: 'windows:3:Default', displayId: 0, frame: { x: -1280, y: 0, width: 1280, height: 720 }, captureKind: 'monitor', outputFrame: { width: 1280, height: 720 }, protocolSessionId: 'rdp:3', captureConfirmed: true };
const raw = { rdpSessionId: 3, captureRects: [descriptor.frame], desktopRect: descriptor.frame, available: true, desktopId: descriptor.desktopId, coordinateUnit: 'physicalPx',
  editable: true, readOnly: false, enabled: true, visible: true, focusToken: 'private-runtime-object',
  inputKind: 'password', controlRect: { x: -1000, y: 500, width: 300, height: 40 },
  caretRect: { x: -990, y: 510, width: 0, height: 20 }, text: 'must-not-leave-provider', appName: 'must-not-leave-provider' };
test('capture enrollment, desktop identity, negative origins, privacy and read-only qualification', () => {
  assert.throws(() => binding({ ...descriptor, captureConfirmed: false }), /CAPTURE_ENROLLMENT_REQUIRED/);
  assert.throws(() => binding({ ...descriptor, captureKind: 'window' }), /CAPTURE_KIND_UNSUPPORTED/);
  assert.equal(metadata({ ...raw, captureRects: [{ ...descriptor.frame, width: 1920 }] }, descriptor, 'runtime').reason, 'capture-mismatch');
  const scaled = metadata(raw, { ...descriptor, outputFrame: { width: 640, height: 360 } }, 'runtime');
  assert.equal(scaled.target.controlRect.x, 140); assert.equal(scaled.target.controlRect.height, 20);
  let result = metadata(raw, descriptor, 'runtime');
  assert(result.available); assert.equal(result.target.controlRect.x, 280); assert.equal(result.target.caretRect.width, 1);
  assert.equal(result.target.inputKind, 'password'); assert(!JSON.stringify(result).includes('must-not-leave-provider'));
  assert(!JSON.stringify(result).includes('private-runtime-object'));
  assert.equal(metadata({ ...raw, desktopId: 'windows:0:Default' }, descriptor, 'runtime').reason, 'desktop-mismatch');
  assert.equal(metadata({ ...raw, coordinateUnit: 'logicalPx' }, descriptor, 'runtime').available, false);
  assert.equal(metadata({ ...raw, readOnly: true }, descriptor, 'runtime').target, null);
  assert.equal(metadata({ ...raw, caretRect: null, controlRect: { x: 0, y: 0, width: 100, height: 30 } }, descriptor, 'runtime').reason, 'outside-capture');
});
test('dedicated mTLS grants, owner lease, binding mismatch, static geometry and revocation', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-text-test-'));
  const state = join(root, 'state'); let server;
  try {
    await initialize(state); await enroll(state, descriptor);
    const config = JSON.parse(await readFile(join(state, 'text-input.json'), 'utf8')); config.port = 0;
    await writeFile(join(state, 'text-input.json'), JSON.stringify(config));
    const provider = { async read() { return raw; }, close() {} };
    server = new TextInputServer(state, provider); const address = await server.start();
    const url = 'https://127.0.0.1:' + address.port, ca = await readFile(join(state, 'pki', 'ca.pem'));
    const unpaired = new Client({ url, ca });
    await assert.rejects(unpaired.request('/v1/text-input/bind', {}), /DEVICE_UNAUTHORIZED/);
    const invite = await invitation(state, ['capture']); const identityDir = join(root, 'client');
    const csr = await createClientIdentity(identityDir);
    const pair = await unpaired.request('/v1/text-input/pair', { code: invite.code, csr, name: 'fixture' });
    await assert.rejects(unpaired.request('/v1/text-input/pair', { code: invite.code, csr, name: 'fixture' }), /PAIR_INVALID_OR_EXPIRED/);
    const client = new Client({ url, ca, cert: pair.cert, key: await readFile(join(identityDir, 'client.key')) });
    const hello = await client.request('/v1/text-input/handshake', { version: 1, instance: invite.serverInstance, deviceId: pair.deviceId });
    assert.equal(hello.capabilities.coordinates, 'capturePhysicalPx');
    await assert.rejects(client.request('/v1/text-input/handshake', { version: 1, instance: 'wrong', deviceId: pair.deviceId }), /IDENTITY_MISMATCH/);
    const request = { version: 1, protocol: 'rdp', connectionKey: descriptor.connectionKey,
      ownerNonce: 'session_7_generation_10_geometry_3', displayId: 0, frameWidth: 1280, frameHeight: 720, protocolSessionId: 'rdp:3' };
    await assert.rejects(client.request('/v1/text-input/bind', { ...request, frameWidth: 800 }), /CAPTURE_BINDING_MISMATCH/);
    const bound = await client.request('/v1/text-input/bind', request);
    assert.equal(bound.instance, invite.serverInstance); assert.equal(bound.deviceId, pair.deviceId);
    await assert.rejects(client.request('/v1/text-input/snapshot', { version: 1, lease: bound.lease, ownerNonce: 'different' }), /LEASE_EXPIRED/);
    const poll = { version: 1, lease: bound.lease, ownerNonce: request.ownerNonce };
    const first = await client.request('/v1/text-input/snapshot', poll);
    const second = await client.request('/v1/text-input/snapshot', poll);
    assert(second.sequence > first.sequence); assert.deepEqual(second.target, first.target);
    assert(!JSON.stringify(first).includes('must-not-leave-provider'));
    await assert.rejects(client.request('/v1/rpc', { method: 'turn.start', params: {} }), /ROUTE_NOT_FOUND/);
    const next = await client.request('/v1/text-input/bind', { ...request, ownerNonce: 'new_generation' });
    assert(next.lease !== bound.lease);
    assert((await client.request('/v1/text-input/snapshot', poll)).available); // another canvas cannot retire this owner
    const renewed = await client.request('/v1/text-input/bind', request);
    assert(renewed.lease !== bound.lease); await assert.rejects(client.request('/v1/text-input/snapshot', poll), /LEASE_EXPIRED/);
    revoke(state, pair.deviceId); await assert.rejects(client.request('/v1/text-input/bind', request), /DEVICE_UNAUTHORIZED/);
  } finally { if (server) await server.stop(); await rm(root, { recursive: true, force: true }); }
});


test('retired provider stdout/exit cannot resolve or kill the successor query', { timeout: 10000 }, async () => {
  const { DesktopProvider } = await import('../packages/text-input/provider.mjs');
  const root = await mkdtemp(join(tmpdir(), 'text-provider-epoch-'));
  const source = join(root, 'provider.mjs'), marker = join(root, 'started');
  await writeFile(source, `import fs from 'node:fs';
    const first = !fs.existsSync(process.argv[2]); fs.writeFileSync(process.argv[2], 'ready');
    process.on('SIGTERM', () => {});
    process.stdin.once('data', () => setTimeout(() => { console.log(JSON.stringify({ available: true, focusToken: first ? 'retired' : 'current' }));
      setTimeout(() => process.exit(0), 50); }, first ? 300 : 400));`);
  const provider = new DesktopProvider({ executable: process.execPath, args: [source, marker], timeout: 150 });
  const children = [];
  try {
    const first = provider.read(); children.push(provider.process); assert.equal((await first).available, false);
    provider.timeout = 1500;
    const next = provider.read(); children.push(provider.process);
    assert.equal((await next).focusToken, 'current');
  } finally { provider.close(); for (const child of children) child?.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
