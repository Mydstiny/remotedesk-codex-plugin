import {readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {init,configuration,addProject,invite,revoke,status} from './admin.mjs';
import {Client,loadClient,pairClient,submit} from './client.mjs';
import {renewServer} from './pki.mjs';
import {Store} from './store.mjs';
import {privateDirectory} from './privacy.mjs';
import {withLifecycleLock} from './lifecycle-lock.mjs';
import {DockerExecutor} from './docker-executor.mjs';
import {service,watchStopRequests} from './service.mjs';
import {Fault,requireThat} from './errors.mjs';
const print=v=>console.log(JSON.stringify(v,null,2));
const help=`Commands: doctor, probe, init, project-add, invite, revoke, status, renew-server, recover, serve, service, pair, read, write, retry, watch
Global: --state <private directory> (default ~/.remotedesk/<engine>)
init: --host <bind IP> --hosts <certificate DNS/IP,...> --port <port>
project-add: --id <id> --path <project> [--title <title>] [--provider <host provider>] [--model <model>] [--image <pinned Docker image>]
invite: --projects <id,...> --out <private invite file> [--role viewer|operator]
revoke: --device <device id>; recover: only after this bridge process is stopped
service: --action render|install|start|stop|status|uninstall [--out <definition file>]
pair: --client <new private directory> --url <https endpoint> --invite <file> [--servername <cert hostname>]
read/write: --client <directory> --method <protocol method> --params <JSON file>
retry: --client <directory> --operation <original operation id>
watch: --client <directory> --cursor <snapshot cursor>
`;
export async function main({engine,doctor,serve,entry,extra},argv=process.argv.slice(2)){
 const command=argv.shift();const o={};const valid=new Set(['state','host','hosts','port','id','path','title','provider','model','image','vision','projects','out','role','device','action','client','url','invite','servername','name','method','params','operation','cursor','runtime-root','profile','package']);
 try{
  for(let i=0;i<argv.length;i++){if(argv[i]==='--json')continue;const key=argv[i].slice(2);requireThat(argv[i].startsWith('--')&&valid.has(key)&&!(key in o)&&argv[i+1]&&!argv[i+1].startsWith('--'),'CLI_ARGUMENT_INVALID');o[key]=argv[++i];}
  if(!command||command==='help'){console.log(help);return;}
  if(command==='doctor'||command==='probe'){const report=await doctor({probe:command==='probe',runtimeRoot:o['runtime-root']});print(report);if(report.status!=='ok')process.exitCode=2;return;}
  const state=resolve(o.state??join(homedir(),'.remotedesk',engine));
  if(command==='init'){print(await init(state,{engine,...(o.host?{host:o.host}:{}),...(o.hosts?{hosts:o.hosts.split(',')}:{}),...(o.port?{port:Number(o.port)}:{})}));return;}
  if(['pair','read','write','retry','watch'].includes(command)){
   requireThat(o.client,'CLIENT_DIRECTORY_REQUIRED');const clientDirectory=resolve(o.client);
   if(command==='pair'){requireThat(o.url&&o.invite,'PAIR_ARGUMENTS_REQUIRED');print(await pairClient(clientDirectory,{url:o.url,invite:JSON.parse(await readFile(o.invite,'utf8')),servername:o.servername,name:o.name}));return;}
   if(command==='write'||command==='retry'){requireThat(command==='retry'?o.operation:o.method&&o.params,'REQUEST_ARGUMENTS_REQUIRED');const receipt=await submit(clientDirectory,o.method,o.params?JSON.parse(await readFile(o.params,'utf8')):undefined,{retryId:o.operation});print(receipt);if(receipt.status==='unknown'||receipt.operation?.status!=='succeeded')process.exitCode=2;return;}
   const {client,handshake}=await loadClient(clientDirectory);
   if(command==='read'){requireThat(o.method,'METHOD_REQUIRED');print(await client.read(o.method,o.params?JSON.parse(await readFile(o.params,'utf8')):{}));return;}
   requireThat(o.cursor!==undefined,'SNAPSHOT_CURSOR_REQUIRED');const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());try{await client.events({cursor:Number(o.cursor),runtime:handshake.runtime,signal:controller.signal,onEvent:e=>console.log(JSON.stringify(e))});}catch(e){if(!controller.signal.aborted)throw e;}return;
  }
  await privateDirectory(state);const config=await configuration(state);requireThat(config.engine===engine,'ENGINE_STATE_MISMATCH');
  if(command==='project-add'){const input={id:o.id,path:o.path};for(const k of ['title','provider','model','image','vision'])if(o[k])input[k]=o[k];if(o.vision!==undefined){requireThat(['on','off'].includes(o.vision),'VISION_VALUE_INVALID');input.vision=o.vision==='on';}print(await addProject(state,input));return;}
  if(command==='invite'){requireThat(o.projects&&o.out,'INVITE_ARGUMENTS_REQUIRED');const file=resolve(o.out);requireThat(file.startsWith(state+ (process.platform==='win32'?'\\':'/')),'INVITE_OUTPUT_MUST_BE_IN_PRIVATE_STATE');await writeFile(file,JSON.stringify(await invite(state,{projects:o.projects.split(','),role:o.role}),null,2)+'\n',{mode:0o600,flag:'wx'});print({inviteFile:file,expiresInSeconds:120});return;}
  if(command==='revoke'){requireThat(o.device,'DEVICE_REQUIRED');print(revoke(state,o.device));return;}
  if(command==='status'){print(status(state));return;}
  if(command==='renew-server'){print(await renewServer(join(state,'pki')));return;}
  if(command==='recover'){print(await recover(state));return;}
  if(command==='serve'){try{const saved=JSON.parse(await readFile(join(state,'service.json'),'utf8'));for(const k of ['PATH','DSH_HOME'])if(typeof saved.environment?.[k]==='string')process.env[k]=saved.environment[k];}catch(e){if(e.code!=='ENOENT')throw e;}const dispose=watchStopRequests(state);try{await serve(state,config,o);}catch(e){dispose();throw e;}return;}
  if(command==='service'){const result=await service(o.action,{engine,entry:resolve(entry),state});if(o.action==='render'&&o.out){await writeFile(o.out,result.text,{encoding:process.platform==='win32'?'utf16le':'utf8',mode:0o600});print({file:resolve(o.out)});}else print(result);return;}
  if(extra&&await extra(command,state,config,o))return;
  throw new Fault('CLI_COMMAND_UNKNOWN');
 }catch(e){console.error(JSON.stringify({error:e instanceof Fault?e.code:'LOCAL_COMMAND_FAILED',hint:'Check command help, version, paths, local engine and native service status.'}));process.exitCode=2;}
}
export async function recover(state){return withLifecycleLock(state,()=>recoverLocked(state));}
async function recoverLocked(state){
 const config=await configuration(state),store=new Store(state);const removed=[];
 const dead=pid=>{requireThat(Number.isSafeInteger(pid)&&pid>0,'LOCK_PID_INVALID');try{process.kill(pid,0);throw new Fault('LOCK_PROCESS_STILL_EXISTS');}catch(e){if(e.code!=='ESRCH')throw e;}};
 try{
  const paths=[join(state,'server.lock')];const owner=store.get('meta','instance').id;
  try{for(const file of await readdir(config.coordinationDirectory))if(file.endsWith('.lock'))paths.push(join(config.coordinationDirectory,file));}catch(e){if(e.code!=='ENOENT')throw e;}
  const candidates=[];
  for(const path of paths){let value,raw;try{raw=await readFile(path,'utf8');value=JSON.parse(raw);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(path!==paths[0]&&value.owner!==owner)continue;dead(value.pid);candidates.push({path,raw});}
  // The daemon can outlive the crashed controller. Keep all writer locks until
  // every recorded owned container is confirmed removed.
  if(store.all('container').length)await new DockerExecutor(store).recover();
  for(const {path,raw}of candidates.reverse()){requireThat(await readFile(path,'utf8')===raw,'LOCK_CHANGED');await unlink(path);removed.push(path);}
  store.recover();return {recovered:true,removedLocks:removed,unknownOperations:'Reconcile history before sending a new operation.'};
 }finally{store.close();}
}
