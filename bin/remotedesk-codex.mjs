#!/usr/bin/env node
import { doctor } from '../src/doctor.mjs';

const args = process.argv.slice(2);
if (!['doctor', 'probe'].includes(args[0]) || args.slice(1).some(arg => arg !== '--json') || args.length > 2) {
  console.error('Usage: remotedesk-codex <doctor|probe> [--json]');
  process.exitCode = 64;
} else {
  const controller = new AbortController();
  let interrupted = 0;
  const interrupt = () => { interrupted = 130; controller.abort(); };
  const terminate = () => { interrupted = 143; controller.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const report = await doctor({ probe: args[0] === 'probe', signal: controller.signal });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = interrupted || (report.status === 'ok' ? 0 : 2);
}
