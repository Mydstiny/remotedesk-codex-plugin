#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { initialize, enroll, invitation, revoke, devices, TextInputServer } from '../packages/text-input/server.mjs';
import { DesktopProvider } from '../packages/text-input/provider.mjs';

const [command, directory, ...rest] = process.argv.slice(2);
try {
  if (command === 'probe') {
    const provider = DesktopProvider.platform();
    try { const value = await provider.read(); console.log(JSON.stringify({ available: value.available,
      reason: value.reason || '', desktopId: value.desktopId || '', coordinateUnit: value.coordinateUnit || '' })); }
    finally { provider.close(); }
  } else if (command === 'init' && directory) {
    const input = rest[0] ? JSON.parse(await readFile(rest[0], 'utf8')) : {};
    await initialize(directory, input); console.log('initialized');
  } else if (command === 'enroll' && directory && rest[0]) {
    await enroll(directory, JSON.parse(await readFile(rest[0], 'utf8'))); console.log('enrolled');
  } else if (command === 'invite' && directory && rest.length > 0) {
    console.log(JSON.stringify(await invitation(directory, rest)));
  } else if (command === 'devices' && directory) {
    console.log(JSON.stringify(devices(directory)));
  } else if (command === 'revoke' && directory && rest[0]) {
    revoke(directory, rest[0]); console.log('revoked');
  } else if (command === 'serve' && directory) {
    const server = new TextInputServer(directory); await server.start(); console.log('ready');
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await server.stop(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else { console.log('probe | init <state> [listener-config.json] | enroll <state> <capture-descriptor.json> | invite <state> <binding-id...> | devices <state> | revoke <state> <device-id> | serve <state>'); }
} catch (error) {
  console.error(/^[A-Z0-9_]+$/.test(error.code || error.message) ? error.code || error.message : 'TEXT_INPUT_FAILED'); process.exitCode = 1;
}
