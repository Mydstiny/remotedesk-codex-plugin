import { realpath } from 'node:fs/promises';
import { openSync,readFileSync,unlinkSync,realpathSync,writeFileSync,fsyncSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest,inside } from './admin.mjs';
import { privateDirectory } from './privacy.mjs';
import { requireThat,Fault } from './errors.mjs';
export class ProjectLocks {
 constructor(directory,owner){this.directory=directory;this.owner=owner;this.held=new Map();}
 async prepare(projects){await privateDirectory(this.directory,{create:true});const dir=await realpath(this.directory);for(const p of projects)requireThat(!inside(p.path,dir),'COORDINATION_PROJECT_OVERLAP');}
 async acquire(project,session) {
  requireThat(realpathSync(project.path)===project.path,'PROJECT_PATH_CHANGED');
  const key=digest(process.platform==='win32'?project.path.toLowerCase():project.path);const path=join(this.directory,key+'.lock');
  let file;try{file=openSync(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Fault('PROJECT_BUSY');throw e;}
  const value={owner:this.owner,session,nonce:randomUUID(),pid:process.pid};
  try{writeFileSync(file,JSON.stringify(value));fsyncSync(file);this.held.set(session,{path,value});}finally{closeSync(file);}
 }
 async release(session){const held=this.held.get(session);if(!held)return;const existing=JSON.parse(readFileSync(held.path,'utf8'));requireThat(existing.owner===this.owner && existing.nonce===held.value.nonce,'PROJECT_LOCK_OWNER_CHANGED');unlinkSync(held.path);this.held.delete(session);}
 async close(){for(const s of [...this.held.keys()])await this.release(s);}
}
