// Exercise the real current-user manager with an isolated fixture bridge.
// Does not load a model, provider credentials, user project or existing service.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {init,configuration} from '../packages/bridge-core/lib/admin.mjs';
import {service,serviceDefinition} from '../packages/bridge-core/lib/service.mjs';
import {recover} from '../packages/bridge-core/lib/cli.mjs';
const root=await mkdtemp(join(tmpdir(),'remotedesk-service-')),state=join(root,'private state'),entry=join(root,'fixture host.mjs');
const cli=new URL('../packages/bridge-core/lib/cli.mjs',import.meta.url).href,server=new URL('../packages/bridge-core/lib/server.mjs',import.meta.url).href;
await init(state,{engine:'codex'});const config=await configuration(state);config.port=0;config.coordinationDirectory=join(root,'coordination');await writeFile(join(state,'config.json'),JSON.stringify(config));
await writeFile(entry,`import {main} from ${JSON.stringify(cli)};import {Bridge} from ${JSON.stringify(server)};await main({engine:'codex',entry:${JSON.stringify(entry)},serve:async directory=>{const bridge=new Bridge(directory,{capabilities:{fixture:true},bind(){},async close(){}});process.once('SIGTERM',()=>bridge.stop());process.once('SIGINT',()=>bridge.stop());await bridge.start();}});`);
const options={engine:'codex',entry,state};let installed=false;
const wait=async fn=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('SERVICE_FIXTURE_TIMEOUT');};
const running=async()=>{try{const value=JSON.parse(await readFile(join(state,'server.lock'),'utf8'));process.kill(value.pid,0);return value.pid!==process.pid;}catch{return false;}};
try{
 const def=serviceDefinition(options);assert.notEqual(def.id,serviceDefinition({...options,state:state+'2'}).id);
 installed=true;await service('install',options);await wait(running);await service('install',options);assert.ok((await service('status',options)).nativeStatus);
 await service('stop',options);await wait(async()=>!await running());await service('start',options);await wait(running);await service('stop',options);
 await service('uninstall',options);installed=false;await assert.rejects(access(def.path));await assert.rejects(access(join(state,'service.json')));assert.equal((await configuration(state)).engine,'codex');
 console.log('PASS actual current-user service manager: unique identity, install/retry/status, graceful stop/start, uninstall and state preservation ('+process.platform+')');
}finally{
 if(installed){try{await service('uninstall',options);installed=false;}catch{try{await recover(state);await service('uninstall',options);installed=false;}catch{console.error('FIXTURE_SERVICE_CLEANUP_REQUIRES_INSPECTION');}}}
 if(!installed)await rm(root,{recursive:true,force:true});
}
