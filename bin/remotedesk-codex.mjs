#!/usr/bin/env node
import { doctor } from '../src/doctor.mjs';

const args = process.argv.slice(2);
if (!['doctor', 'probe'].includes(args[0]) || args.slice(1).some(arg => arg !== '--json') || args.length > 2) {
  console.error('Usage: remotedesk-codex <doctor|probe> [--json]');
  process.exitCode = 64;
} else {
  const report = await doctor({ probe: args[0] === 'probe' });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'ok' ? 0 : 2;
}
