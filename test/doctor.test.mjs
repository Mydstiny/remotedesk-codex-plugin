import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../src/doctor.mjs';

test('unknown engine version prevents a probe', async () => {
  const report = await doctor({ command: process.execPath, probe: true });
  assert.equal(report.status, 'blocked');
  assert.equal(report.checks.at(-1).code, 'CODEX_VERSION_UNVERIFIED');
  assert.equal(report.capabilities.remoteAccess, false);
});
test('missing executable returns sanitized diagnostic without a path', async () => {
  const report = await doctor({ command: '/nonexistent/SECRET_SENTINEL' });
  assert.equal(report.status, 'blocked');
  assert.ok(!JSON.stringify(report).includes('SECRET_SENTINEL'));
});
test('an aborted probe starts no engine', async () => {
  const controller = new AbortController();
  controller.abort();
  const report = await doctor({
    command: '/nonexistent/SHOULD_NOT_START',
    signal: controller.signal,
    probe: true,
  });
  assert.equal(report.checks.at(-1).code, 'PROBE_CANCELLED');
});
