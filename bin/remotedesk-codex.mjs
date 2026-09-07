#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {main} from '../packages/bridge-core/lib/cli.mjs';
import {Bridge} from '../packages/bridge-core/lib/server.mjs';
import {doctor} from '../src/doctor.mjs';
import {CodexAdapter} from '../src/codex-adapter.mjs';
await main({engine:'codex',entry:fileURLToPath(import.meta.url),doctor,serve:async directory=>{
 const bridge=new Bridge(directory,new CodexAdapter());let stopping;
 const stop=()=>stopping??=(async()=>{try{await bridge.stop();}catch{console.error('ENGINE_CLEANUP_UNCONFIRMED');process.exitCode=2;}})();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{await bridge.start();console.log(JSON.stringify({ready:true,engine:'codex',protocol:1}));}catch(e){await stop();throw e;}
}});
