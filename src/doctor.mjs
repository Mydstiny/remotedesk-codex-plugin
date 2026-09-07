import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {codexCommand} from './codex-adapter.mjs';
import { StdioRpc, BridgeError } from '../packages/bridge-core/stdio-rpc.mjs';

const exec = promisify(execFile);
const compatibility = JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url)));

export async function doctor({ probe = false, command, signal } = {}) {
  const report = {
    schemaVersion: 1, status: 'blocked', changed: false,
    componentVersions: { adapter: compatibility.adapterVersion, node: process.versions.node, codex: null },
    checks: [], actions: [], requiresUserAction: [],
    warnings: ['DOCKER_PROJECT_CHECK_REQUIRED_BEFORE_SERVE','PROVIDER_AUTHENTICATION_STAYS_ON_HOST'],
    capabilities: { remoteAccess: false, remoteProtocol:1, proEntitlement: 'pro.lifetime' }
  };
  const check = (id, status, code) => report.checks.push({ id, status, code });
  let directory;
  let rpc;
  const abortRpc = () => { if (rpc) void rpc.close().catch(() => {}); };
  try {
    if (signal?.aborted) throw new BridgeError('PROBE_CANCELLED');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new BridgeError('NODE_VERSION_UNSUPPORTED');
    const selected=await codexCommand(command);const { stdout } = await exec(selected.command, [...selected.prefix,'--version'], { timeout: 5000, maxBuffer: 4096, windowsHide: true, signal });
    const version = /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/m.exec(stdout)?.[1];
    report.componentVersions.codex = version ?? null;
    if (!compatibility.codexVersions.includes(version)) throw new BridgeError('CODEX_VERSION_UNVERIFIED');
    check('version', 'pass', 'PINNED_VERSION');
    if (probe) {
      directory = await mkdtemp(join(tmpdir(), 'remotedesk-codex-probe-'));
      rpc = new StdioRpc(selected.command, [...selected.prefix,'--disable','plugins','--disable','hooks','app-server'], { cwd: directory });
      signal?.addEventListener('abort', abortRpc, { once: true });
      if (signal?.aborted) abortRpc();
      const initialized = await rpc.request('initialize', {
        clientInfo: { name: 'remotedesk_ai0_probe', title: 'RemoteDesk AI0 Probe', version: compatibility.adapterVersion },
        capabilities: { experimentalApi: true }
      });
      if (typeof initialized?.userAgent !== 'string') throw new BridgeError('INITIALIZE_SHAPE_CHANGED');
      rpc.notify('initialized');
      check('initialize', 'pass', 'REAL_APP_SERVER_HANDSHAKE');
      const started = await rpc.request('thread/start', {
        cwd: directory, ephemeral: true, environments:[],config:{notify:[]},sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user'
      });
      if (typeof started?.thread?.id !== 'string' || started.approvalPolicy !== 'untrusted' ||
          started.approvalsReviewer !== 'user' || started.sandbox?.type !== 'readOnly') {
        throw new BridgeError('EXECUTION_PROFILE_MISMATCH');
      }
      check('ephemeralThread', 'pass', 'READ_ONLY_PROFILE_ACCEPTED_NO_TURN');
      report.warnings.push('NO_MODEL_TURN_APPROVAL_CANCEL_OR_RESUME_TESTED', 'ENGINE_MAY_WRITE_OWN_OPERATIONAL_LOGS');
    }
    report.status = 'ok';
  } catch (error) {
    const code = signal?.aborted ? 'PROBE_CANCELLED' : error instanceof BridgeError ? error.code : 'LOCAL_PROBE_FAILED';
    check('probe', 'fail', code);
    report.requiresUserAction.push('CHECK_COMPATIBILITY_AND_LOCAL_ENGINE');
  } finally {
    signal?.removeEventListener('abort', abortRpc);
    if (rpc) {
      try { await rpc.close(); }
      catch { report.status = 'blocked'; check('cleanup', 'fail', 'PROCESS_CLEANUP_UNCONFIRMED'); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return report;
}
