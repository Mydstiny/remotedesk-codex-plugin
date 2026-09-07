import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, realpath,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import {tmpdir} from 'node:os';
import {privateDirectory} from '../packages/bridge-core/lib/privacy.mjs';
import {modelProfile} from './model-profile.mjs';
import { randomUUID } from 'node:crypto';
import { DockerExecutor } from '../packages/bridge-core/lib/docker-executor.mjs';
import { workspaceTools,executeWorkspaceTool,validateWorkspaceAnswer,projectDiff } from '../packages/bridge-core/lib/workspace-tools.mjs';
import { StdioRpc } from '../packages/bridge-core/stdio-rpc.mjs';
import { Fault, requireThat, fields, string, object } from '../packages/bridge-core/lib/errors.mjs';
const exec=promisify(execFile);
export const DISABLED_FEATURES=['apps','plugins','hooks','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser','in_app_local_automation','multi_agent','multi_agent_v2','memories','chronicle','workspace_dependencies','remote_plugin','shell_snapshot','skill_mcp_dependency_install','code_mode','code_mode_host','code_mode_only','artifact','image_generation','in_app_chat','realtime_conversation','request_permissions_tool','goals','view_image','shell_tool','token_budget','tool_suggest','skill_search','shell_zsh_fork','shell_snapshot_v2'];
export const APPROVAL_POLICY={granular:{sandbox_approval:false,rules:true,mcp_elicitations:false,request_permissions:false,skill_approval:false}};
export function remoteConfig(profile,mcpNames=[],inheritedEnvironment=[],libraries=[]) {
 const allowed=['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LANG','LC_ALL','TERM'];
 const valueFor=key=>{const name=Object.keys(process.env).find(n=>n.toUpperCase()===key.toUpperCase());return allowed.some(n=>n.toUpperCase()===key.toUpperCase())?(process.env[name]??''):'';};
 const environment=Object.fromEntries([...new Set([...inheritedEnvironment,...allowed])].map(key=>[key,valueFor(key)]));
 return { project_doc_max_bytes:0, default_permissions:profile, permissions:{[profile]:{filesystem:{...Object.fromEntries(libraries.map(p=>[p,'read'])),':root':'deny',':minimal':'read',':tmpdir':'deny',':slash_tmp':'deny',':workspace_roots':{'.':'read','.git':'read','.codex':'read','.agents':'read'}},network:{enabled:false}}},
  features:{...Object.fromEntries(DISABLED_FEATURES.map(n=>[n,false])),skip_host_skill_discovery:true,default_mode_request_user_input:false},
  tools:{experimental_request_user_input:{enabled:false},update_plan:{enabled:false}},notify:[],orchestrator:{mcp:{enabled:false},skills:{enabled:false}},skills:{bundled:{enabled:false},include_instructions:false},mcp_servers:Object.fromEntries(mcpNames.map(n=>[n,{enabled:false}])),allow_login_shell:false,shell_environment_policy:{inherit:'none',ignore_default_excludes:false,set:environment},web_search:'disabled',approval_policy:APPROVAL_POLICY,approvals_reviewer:'user' };
}
export async function codexCommand(explicit) {
 if(explicit) {const p=await realpath(explicit);return p.endsWith('.js')?{command:process.execPath,prefix:[p]}:{command:p,prefix:[]};}
 for(const p of (process.env.PATH??'').split(delimiter)) {
  try {
   if(process.platform==='win32') {const file=join(p,'node_modules','@openai','codex','bin','codex.js');await access(file);return {command:process.execPath,prefix:[file]};}
   const file=await realpath(join(p,'codex'));return file.endsWith('.js')?{command:process.execPath,prefix:[file]}:{command:file,prefix:[]};
  }catch{/* continue PATH */}
 }
 throw new Fault('CODEX_EXECUTABLE_NOT_FOUND');
}
export class CodexAdapter {
 capabilities={sessions:true,turns:true,steer:true,cancel:true,approvals:true,questions:true,diffs:true,attachments:['text/plain','image/png','image/jpeg'],execution:'docker-project-mount-no-network',outsideSandboxApproval:false};
 constructor({command,providerOverrides,executor,diagnostic}={}) {this.diagnostic=diagnostic;this.customExecutor=executor;this.explicit=command;this.providerOverrides=providerOverrides;this.metadata=new Map();this.rpcs=new Map();this.turns=new Map();this.diffs=new Map();this.loading=new Map();this.aborters=new Map();this.runs=new Map();this.closed=false;}
 bind(core){this.core=core;this.executor=this.customExecutor??new DockerExecutor(core.storage);}
 async prepare(){await this.executor.recover();for(const p of this.core.projects)await this.executor.check(p);}
 project(s){const p=this.core.projects.find(p=>p.id===s.project);requireThat(p,'PROJECT_NOT_FOUND');return p;}
 async connect(s,p) {
  requireThat(!this.closed,'ADAPTER_DISPOSED');
  if(this.rpcs.has(s.id))return this.rpcs.get(s.id);
  if(this.loading.has(s.id))return this.loading.get(s.id);
  if(this.rpcs.size+this.loading.size>=8){const idle=[...this.rpcs.keys()].find(id=>!this.runs.has(id));if(idle)await this.deactivate({id:idle});}requireThat(this.rpcs.size+this.loading.size<8,'ENGINE_SESSION_LIMIT');
  const pending=this.open(s,p);this.loading.set(s.id,pending);try{return await pending;}finally{this.loading.delete(s.id);}
 }
 async open(s,p) {
  requireThat(!s.upstream||s.executionProfile==='container-v1','SESSION_PROFILE_UNVERIFIED');const command=await codexCommand(this.explicit);
  const {stdout}=await exec(command.command,[...command.prefix,'--version'],{timeout:5000,maxBuffer:4096,windowsHide:true});
  requireThat(/^codex(?:-cli)? 0\.153\.4\s*$/.test(stdout.trim()),'CODEX_VERSION_UNVERIFIED');
  const spawn=extra=>{const rpc=new StdioRpc(command.command,[...command.prefix,...DISABLED_FEATURES.flatMap(f=>['--disable',f]),'-c','notify=[]',...extra,'app-server'],{cwd:p.path,timeoutMs:45000,maxFrameBytes:16000000,requestHandler:(method,params)=>this.serverRequest(s,method,params)});if(this.diagnostic)rpc.on('requestDiagnostic',this.diagnostic);return rpc;};let rpc=spawn([]),metadataDirectory;
  try {
   await rpc.request('initialize',{clientInfo:{name:'remotedesk_bridge',title:'RemoteDesk',version:'0.2.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
   // Inspect effective names through the documented API; never log or persist
   // the config contents, credential references, auth, or unrelated sessions.
   const effective=await rpc.request('config/read',{cwd:p.path,includeLayers:false});
   const names=Object.keys(effective.config?.mcp_servers??{});
   let model=s.model??p.model??this.providerOverrides?.model??effective.config?.model;
   const provider=s.provider??p.provider??this.providerOverrides?.model_provider??effective.config?.model_provider??'openai';
   let selected,cursorModel;let pageCount=0;
   do{const page=await rpc.request('model/list',{limit:100,...(cursorModel?{cursor:cursorModel}:{})});selected=page.data.find(m=>model?m.model===model:m.isDefault);cursorModel=page.nextCursor;requireThat(++pageCount<=10,'MODEL_CATALOG_LIMIT');}while(!selected&&cursorModel);
   model??=selected?.model;string(model,200);string(provider,200);
   await rpc.close();metadataDirectory=await mkdtemp(join(tmpdir(),'remotedesk-codex-metadata-'));await privateDirectory(metadataDirectory,{create:true});
   const inputModalities=s.inputModalities??(p.vision===true?['text','image']:p.vision===false?['text']:selected?.inputModalities??['text']);
   const catalog=join(metadataDirectory,'models.json');await writeFile(catalog,JSON.stringify(modelProfile(model,{...selected,inputModalities})),{mode:0o600});
   rpc=spawn(['-c','model_catalog_json='+JSON.stringify(catalog)]);
   await rpc.request('initialize',{clientInfo:{name:'remotedesk_bridge',title:'RemoteDesk',version:'0.2.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
   const profile='remotedesk-'+randomUUID();
   const config={...remoteConfig(profile,names,Object.keys(effective.config?.shell_environment_policy?.set??{})),...this.providerOverrides};
   const params={cwd:p.path,approvalPolicy:APPROVAL_POLICY,approvalsReviewer:'user',config,modelProvider:provider,model,allowProviderModelFallback:false};
   const result=await rpc.request(s.upstream?'thread/resume':'thread/start',s.upstream?{...params,threadId:s.upstream,excludeTurns:true}:{...params,environments:[],dynamicTools:workspaceTools.map(tool=>({type:'function',...tool}))});
   requireThat(result.activePermissionProfile?.id===profile && result.sandbox?.type==='readOnly' && result.sandbox.networkAccess===false && result.approvalsReviewer==='user' && Object.entries(APPROVAL_POLICY.granular).every(([key,value])=>result.approvalPolicy?.granular?.[key]===value),'EXECUTION_PROFILE_MISMATCH');
   s.upstream=result.thread.id;s.model=model;s.provider=provider;s.executionProfile='container-v1';s.inputModalities=inputModalities;
   // A new project layer or upstream change must never make an inherited MCP
   // tool available. Block before the first model turn if any server remains.
   let cursor;let count=0;
   do {const page=await rpc.request('mcpServerStatus/list',{threadId:s.upstream,detail:'toolsAndAuthOnly',limit:100,...(cursor?{cursor}:{})});requireThat(page.data.every(server=>server.runtimeStatus==='disabled'),'MCP_ISOLATION_FAILED');cursor=page.nextCursor;requireThat(++count<=10,'MCP_INVENTORY_LIMIT');}while(cursor);
   requireThat(!this.closed,'ADAPTER_DISPOSED');rpc.on('notification',message=>this.notification(s,message));this.rpcs.set(s.id,rpc);this.metadata.set(s.id,metadataDirectory);
   return rpc;
  } catch(e) {await rpc.close();if(metadataDirectory)await rm(metadataDirectory,{recursive:true,force:true});throw e;}
 }
 async create(s,p){await this.connect(s,p);return {upstream:s.upstream,model:s.model,provider:s.provider,executionProfile:s.executionProfile,inputModalities:s.inputModalities};}
 async resume(s){await this.connect(s,this.project(s));}
 async read(s,{cursor}={}) {
  const rpc=await this.connect(s,this.project(s));
  // Upstream paginated transcript calls avoid a single unbounded hydration.
  const turns=await rpc.request('thread/turns/list',{threadId:s.upstream,limit:20,itemsView:'full',...(cursor?{cursor}:{})});
  return {status:this.turns.has(s.id)?'running':'idle',model:s.model,provider:s.provider,turns:turns.data??turns.turns??[],nextCursor:turns.nextCursor??null};
 }
 async start(s,text,attachments=[]) {
  requireThat(!this.runs.has(s.id),'TURN_ALREADY_RUNNING');
  const run={generation:randomUUID(),turnId:null,cancelRequested:false,finished:false,controller:new AbortController()};
  run.ready=new Promise(resolve=>{run.readyResolve=resolve;});run.done=new Promise(resolve=>{run.doneResolve=resolve;});
  // Reserve synchronously before connect or any other await.
  this.runs.set(s.id,run);this.turns.set(s.id,'starting');this.aborters.set(s.id,run.controller);
  try {
   const rpc=await this.connect(s,this.project(s));
   requireThat(!run.cancelRequested,'TURN_CANCELLED_BEFORE_DISPATCH');requireThat(!attachments.some(a=>a.mime!=='text/plain')||s.inputModalities?.includes('image'),'MODEL_IMAGE_CAPABILITY_UNDECLARED');
   const input=[{type:'text',text},...attachments.map(a=>a.mime==='text/plain'?{type:'text',text:Buffer.from(a.data,'base64').toString('utf8')}:{type:'image',url:`data:${a.mime};base64,${a.data}`})];
   run.dispatched=true;
   const r=await rpc.request('turn/start',{threadId:s.upstream,input,environments:[],clientUserMessageId:randomUUID()});
   run.turnId??=r.turn.id;run.readyResolve();
   if(!run.finished && this.runs.get(s.id)===run)this.turns.set(s.id,run.turnId);
   if(run.cancelRequested && !run.finished)await this.interrupt(s,run);
   return {turnId:r.turn.id,cancelRequested:run.cancelRequested};
  }catch(e){this.finish(s,run);throw e;}finally{run.readyResolve();}
 }
 finish(s,run) {run.finished=true;run.controller.abort();run.doneResolve();if(this.runs.get(s.id)===run){this.runs.delete(s.id);this.turns.delete(s.id);this.aborters.delete(s.id);}}
 async interrupt(s,run) {
  if(run.finished || !run.turnId)return;
  run.interruptPromise??=this.rpcs.get(s.id).request('turn/interrupt',{threadId:s.upstream,turnId:run.turnId});
  await run.interruptPromise;
 }
 async steer(s,text) {const run=this.runs.get(s.id);requireThat(run?.turnId&&!run.cancelRequested&&!run.finished,'NO_ACTIVE_TURN');return this.rpcs.get(s.id).request('turn/steer',{threadId:s.upstream,expectedTurnId:run.turnId,input:[{type:'text',text}],clientUserMessageId:randomUUID()});}
 async cancel(s) {
  if(!s)return;const run=this.runs.get(s.id);if(!run)return;
  run.cancelRequested=true;run.controller.abort();await run.ready;
  if(run.finished)return;
  try {
   await this.interrupt(s,run);
   let timer;try{await Promise.race([run.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Fault('CANCEL_DID_NOT_SETTLE')),15000);})]);}finally{clearTimeout(timer);}
  }catch(e){
   // Terminate only this adapter-owned engine when cancellation cannot converge.
   const rpc=this.rpcs.get(s.id);if(rpc){await rpc.close();this.rpcs.delete(s.id);}this.finish(s,run);throw e;
  }
 }
 async diff(s) {return projectDiff(this.executor,this.project(s));}
 notification(s,{method,params}) {
  if(params?.threadId!==s.upstream)return;
  const run=this.runs.get(s.id);
  if(method==='turn/started' && run){run.turnId=params.turn.id;if(!run.finished)this.turns.set(s.id,params.turn.id);}
  if(method==='turn/completed' && run && (!run.turnId || run.turnId===params.turn.id)){this.finish(s,run);this.core.emit(s.id,{type:'execution.idle'});}
  if(method==='turn/diff/updated')this.diffs.set(s.id,params.diff);
  // Only a known thread's model, tool and turn events cross the public facade.
  if(/^(turn\/|item\/|thread\/tokenUsage\/)/.test(method))this.core.emit(s.id,{type:method,params});
 }
 validateAnswer(request,answer){validateWorkspaceAnswer(request,answer);}
 async serverRequest(s,method,params) {
  requireThat(params?.threadId===s.upstream && params.turnId===this.turns.get(s.id),'UPSTREAM_REQUEST_STALE');
  requireThat(method==='item/tool/call'&&!params.namespace,'UPSTREAM_METHOD_UNSUPPORTED');
  const signal=this.aborters.get(s.id)?.signal;
  try{const result=await executeWorkspaceTool({executor:this.executor,core:this.core,session:s,project:this.project(s),name:params.tool,args:params.arguments,signal});return {contentItems:[{type:'inputText',text:JSON.stringify(result)}],success:true};}
  catch(e){return {contentItems:[{type:'inputText',text:e instanceof Fault?e.code:'TOOL_EXECUTION_FAILED'}],success:false};}
 }
 async deactivate(s){requireThat(!this.runs.has(s.id),'TURN_ALREADY_RUNNING');const rpc=this.rpcs.get(s.id);if(rpc){await rpc.close();this.rpcs.delete(s.id);}const directory=this.metadata.get(s.id);if(directory){await rm(directory,{recursive:true,force:true});this.metadata.delete(s.id);}}
 async close(){if(this.closed)return;this.closed=true;for(const run of this.runs.values())run.cancelRequested=true;for(const controller of this.aborters.values())controller.abort();await Promise.allSettled([...this.loading.values()]);const results=await Promise.allSettled([...this.rpcs.values()].map(r=>r.close()));this.rpcs.clear();for(const directory of this.metadata.values())await rm(directory,{recursive:true,force:true});this.metadata.clear();if(results.some(r=>r.status==='rejected'))throw new Fault('ENGINE_CLEANUP_UNCONFIRMED');await this.executor?.recover();}
}
