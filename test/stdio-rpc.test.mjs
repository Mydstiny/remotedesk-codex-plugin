import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { StdioRpc } from '../packages/bridge-core/stdio-rpc.mjs';

function fixture(t, mode, options = {}) {
  const rpc = new StdioRpc(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)), mode],
    options,
  );
  t.after(() => rpc.close());
  return rpc;
}
test('preserves split UTF-8 frames', async (t) => {
  assert.equal(await fixture(t, 'split').request('test'), '中文🙂');
});
test('correlates out-of-order responses', async (t) => {
  const rpc = fixture(t, 'reverse');
  assert.deepEqual(await Promise.all([rpc.request('one'), rpc.request('two')]), ['one', 'two']);
});
test('rejects every server approval request without granting', async (t) => {
  assert.equal(await fixture(t, 'approval').request('test'), -32601);
});
for (const [mode, code] of [
  ['invalid', 'INVALID_FRAME'],
  ['oversize', 'FRAME_TOO_LARGE'],
  ['unknown', 'UNEXPECTED_RESPONSE'],
  ['exit', 'PROCESS_CLOSED'],
  ['hang', 'REQUEST_TIMEOUT_RECONCILE'],
]) {
  test(`fails closed on ${mode}`, async (t) => {
    const rpc = fixture(t, mode, {
      timeoutMs: process.platform === 'win32' ? 10000 : 500,
      maxFrameBytes: 1024,
    });
    await assert.rejects(rpc.request('test'), { code });
    await assert.rejects(rpc.request('later'), { code: 'TRANSPORT_CLOSED' });
  });
}
test('sanitizes upstream errors', async (t) => {
  await assert.rejects(
    fixture(t, 'error').request('test'),
    (e) => e.code === 'UPSTREAM_REQUEST_FAILED' && !e.message.includes('SECRET_SENTINEL'),
  );
});
test('bounds pending requests and settles every request on close', async (t) => {
  const rpc = fixture(t, 'hang', { maxPending: 1 });
  const first = assert.rejects(rpc.request('one'), { code: 'TRANSPORT_CLOSED' });
  await assert.rejects(rpc.request('two'), { code: 'TOO_MANY_REQUESTS' });
  await rpc.close();
  await first;
  await rpc.close();
});
test('rejects missing executable without exposing path', async (t) => {
  const rpc = new StdioRpc('/nonexistent/remotedesk-test-command');
  t.after(() => rpc.close());
  await assert.rejects(rpc.request('test'), {
    code: process.platform === 'win32' ? 'PROCESS_CLOSED' : 'PROCESS_START_FAILED',
  });
});
test('bounds cleanup and kills owned descendants that inherit stdout and ignore SIGTERM', async (t) => {
  const rpc = fixture(t, 'descendant');
  const children = await rpc.request('launch');
  const start = Date.now();
  await rpc.close();
  assert.ok(Date.now() - start < 2500);
  for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test(
  'reports unconfirmed cleanup when an escaped descendant holds stdout',
  { skip: process.platform === 'win32' },
  async (t) => {
    const rpc = new StdioRpc(process.execPath, [
      fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url)),
      'escaped',
    ]);
    let escaped;
    t.after(async () => {
      if (escaped) {
        try {
          process.kill(escaped, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await rpc.close().catch(() => {});
    });
    escaped = await rpc.request('launch');
    const start = Date.now();
    await assert.rejects(rpc.close(), { code: 'PROCESS_CLEANUP_UNCONFIRMED' });
    assert.ok(Date.now() - start < 2500);
    assert.doesNotThrow(() => process.kill(escaped, 0));
  },
);
