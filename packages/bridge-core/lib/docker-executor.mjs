import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Fault, requireThat, string } from './errors.mjs';
const exec=promisify(execFile);
const IMAGE=/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/;
export class DockerExecutor {
 constructor(store,{command='docker'}={}){this.store=store;this.command=command;this.owner=store.get('meta','instance').id;}
 async docker(args,options={}) {return exec(this.command,args,{timeout:15000,maxBuffer:1048576,windowsHide:true,...options});}
 async check(project) {
  requireThat(IMAGE.test(project.image??''),'DOCKER_PINNED_IMAGE_REQUIRED');
  const context=JSON.parse((await this.docker(['context','inspect','--format','{{json .Endpoints.docker.Host}}'])).stdout);
  requireThat(typeof context==='string' && /^(unix:\/\/|npipe:\/\/)/.test(context),'DOCKER_LOCAL_DAEMON_REQUIRED');
  // Explicit DOCKER_HOST/CONTEXT can override the selected context inspected above.
  requireThat(!process.env.DOCKER_HOST || /^(unix:\/\/|npipe:\/\/)/.test(process.env.DOCKER_HOST),'DOCKER_LOCAL_DAEMON_REQUIRED');
  requireThat((await this.docker(['info','--format','{{.OSType}}'])).stdout.trim()==='linux','DOCKER_LINUX_CONTAINERS_REQUIRED');
  await this.docker(['image','inspect',project.image,'--format','{{.Id}}']);
  requireThat(await realpath(project.path)===project.path,'PROJECT_PATH_CHANGED');
 }
 async cleanup(name) {
  requireThat(/^remotedesk-[a-f0-9-]{36}$/.test(name),'CONTAINER_ID_INVALID');
  let exists;
  try{exists=JSON.parse((await this.docker(['container','ls','-a','--filter',`name=^/${name}$`,'--format','{{json .Names}}'])).stdout.trim()||'null');}catch{throw new Fault('DOCKER_CLEANUP_UNCONFIRMED');}
  if(exists){
   const label=(await this.docker(['inspect',name,'--format','{{index .Config.Labels "org.remotedesk.owner"}}'])).stdout.trim();
   requireThat(label===this.owner,'CONTAINER_OWNER_MISMATCH');
   try{await this.docker(['rm','--force',name]);}catch{throw new Fault('DOCKER_CLEANUP_UNCONFIRMED');}
  }
  this.store.delete('container',name);
 }
 async recover(){for(const c of this.store.all('container'))await this.cleanup(c.id);}
 async run(project,command,{signal,readOnly=false}={}) {
  string(command,64000);requireThat(!signal?.aborted,'EXECUTION_CANCELLED');await this.check(project);requireThat(!signal?.aborted,'EXECUTION_CANCELLED');
  const name='remotedesk-'+randomUUID();this.store.put('container',name,{id:name,project:project.id,created:Date.now()});
  // Model text is only the final sh argument. It can never become Docker flags.
  const user=process.platform!=='win32'?`${process.getuid()}:${process.getgid()}`:'1000:1000';
  requireThat(user.split(':')[0]!=='0','NON_ROOT_HOST_REQUIRED');
  const args=['create','--name',name,'--label',`org.remotedesk.owner=${this.owner}`,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','128','--memory','512m','--cpus','1','--user',user,'--mount',`type=bind,source=${project.path},target=/workspace${readOnly?',readonly':''}`,'--tmpfs','/tmp:rw,noexec,nosuid,size=67108864','--workdir','/workspace','--init','--pull','never',project.image,'/bin/sh','-c',command];
  try{
   requireThat(!project.path.includes(',')&&!project.path.includes('\n'),'DOCKER_PATH_UNSUPPORTED');
   await this.docker(args,{signal});
   let output;
   try{output=await this.docker(['start','--attach',name],{timeout:180000,signal,maxBuffer:1048576});}
   catch(e){if(signal?.aborted)throw new Fault('EXECUTION_CANCELLED');if(e.killed||e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw new Fault('EXECUTION_LIMIT');if(Number.isInteger(e.code))output={stdout:e.stdout??'',stderr:e.stderr??''};else throw new Fault('CONTAINER_EXECUTION_FAILED');}
   const status=JSON.parse((await this.docker(['inspect',name,'--format','{{json .State}}'])).stdout);requireThat(status.Status==='exited'&&Number.isInteger(status.ExitCode),'CONTAINER_DID_NOT_EXIT');
   return {exitCode:status.ExitCode,stdout:output.stdout,stderr:output.stderr};
  }finally{await this.cleanup(name);}
 }
}
