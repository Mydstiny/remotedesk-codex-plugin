import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {requireThat} from './errors.mjs';
const exec=promisify(execFile),xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const unit=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$','$$')+'"';
const win=s=>'"'+s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
export function serviceDefinition({engine,entry,state,platform=process.platform,node=process.execPath,user=homedir(),path=process.env.PATH??''}) {
 requireThat(['codex','dsh'].includes(engine));for(const v of [entry,state,node,user,path])requireThat(typeof v==='string'&&!/[\0\r\n]/.test(v),'SERVICE_VALUE_INVALID');
 const id=`com.remotedesk.${engine}`,args=[entry,'serve','--state',state],environment={PATH:path,...(process.env.DSH_HOME?{DSH_HOME:process.env.DSH_HOME}:{})};
 if(platform==='darwin')return {id,path:join(user,'Library','LaunchAgents',id+'.plist'),text:`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${[node,...args].map(v=>'<string>'+xml(v)+'</string>').join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k,v])=>'<key>'+xml(k)+'</key><string>'+xml(v)+'</string>').join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>45</integer><key>StandardOutPath</key><string>${xml(join(state,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(state,'service.log'))}</string></dict></plist>\n`};
 if(platform==='linux')return {id,path:join(user,'.config','systemd','user',id+'.service'),text:`[Unit]\nDescription=RemoteDesk ${engine} bridge\n[Service]\nType=simple\nExecStart=${[node,...args].map(unit).join(' ')}\n${Object.entries(environment).map(([k,v])=>'Environment='+unit(k+'='+v)).join('\n')}\nRestart=no\nTimeoutStopSec=45\nKillMode=control-group\nUMask=0077\n[Install]\nWantedBy=default.target\n`};
 requireThat(platform==='win32','PLATFORM_UNSUPPORTED');
 // InteractiveToken uses the current signed-in user's existing provider access;
 // no stored account password, elevated token, SYSTEM identity, or boot service.
 return {id,path:join(state,'service.xml'),text:`<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args.map(win).join(' '))}</Arguments><WorkingDirectory>${xml(dirname(entry))}</WorkingDirectory></Exec></Actions></Task>\n`};
}
export async function service(action,options){
 const def=serviceDefinition(options),platform=process.platform;
 requireThat(['render','install','start','stop','status','uninstall'].includes(action),'SERVICE_ACTION_INVALID');
 if(action==='render')return def;
 const run=async(command,args)=>{try{return (await exec(command,args,{timeout:60000,maxBuffer:32000,windowsHide:true})).stdout;}catch{throw new Error('SERVICE_COMMAND_FAILED_CHECK_NATIVE_MANAGER');}};
 const record=join(options.state,'service.json');
 if(action==='install'){
  await mkdir(dirname(def.path),{recursive:true});
  await writeFile(record,JSON.stringify({id:def.id,path:def.path,entry:options.entry,node:process.execPath,environment:{PATH:process.env.PATH??'',...(process.env.DSH_HOME?{DSH_HOME:process.env.DSH_HOME}:{})}}),{mode:0o600,flag:'wx'});
  await writeFile(def.path,def.text,{encoding:platform==='win32'?'utf16le':'utf8',mode:0o600});
  if(platform==='darwin')await run('launchctl',['bootstrap',`gui/${process.getuid()}`,def.path]);
  if(platform==='linux'){await run('systemctl',['--user','daemon-reload']);await run('systemctl',['--user','enable','--now',def.id+'.service']);}
  if(platform==='win32'){await run('schtasks.exe',['/Create','/TN',def.id,'/XML',def.path]);await run('schtasks.exe',['/Run','/TN',def.id]);}
  return {installed:true,id:def.id};
 }
 const registered=JSON.parse(await readFile(record,'utf8'));requireThat(registered.id===def.id&&registered.path===def.path,'SERVICE_REGISTRATION_MISMATCH');
 let result;
 if(platform==='darwin')result=await run('launchctl',action==='status'?['print',`gui/${process.getuid()}/${def.id}`]:action==='start'?['kickstart',`gui/${process.getuid()}/${def.id}`]:action==='stop'?['kill','SIGTERM',`gui/${process.getuid()}/${def.id}`]:['bootout',`gui/${process.getuid()}`,def.path]);
 if(platform==='linux')result=await run('systemctl',['--user',...(action==='uninstall'?['disable','--now']: [action]),def.id+'.service']);
 if(platform==='win32'){if(action==='uninstall'){try{await run('schtasks.exe',['/End','/TN',def.id]);}catch{}}result=await run('schtasks.exe',action==='status'?['/Query','/TN',def.id,'/FO','LIST']:action==='start'?['/Run','/TN',def.id]:action==='stop'?['/End','/TN',def.id]:['/Delete','/TN',def.id,'/F']);}
 if(action==='uninstall'){await unlink(def.path);await unlink(record);if(platform==='linux')await run('systemctl',['--user','daemon-reload']);}
 return {action,id:def.id,...(action==='status'?{nativeStatus:result}:{})};
}
