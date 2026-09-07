import { mkdir,chmod,stat,readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Fault, requireThat } from './errors.mjs';
const exec=promisify(execFile);
export async function privateDirectory(directory,{create=false,empty=false}={}) {
 if(create)await mkdir(directory,{recursive:true,mode:0o700});
 const info=await stat(directory);requireThat(info.isDirectory(),'PRIVATE_DIRECTORY_REQUIRED');
 if(empty)requireThat((await readdir(directory)).length===0,'STATE_DIRECTORY_NOT_EMPTY');
 if(process.platform!=='win32') {
  requireThat(info.uid===process.getuid(),'PRIVATE_DIRECTORY_OWNER');
  if(create)await chmod(directory,0o700);else requireThat((info.mode&0o077)===0,'PRIVATE_DIRECTORY_PERMISSIONS');return;
 }
 const path=Buffer.from(resolve(directory),'utf8').toString('base64');
 const prelude=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$phase='IDENTITY';try{$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;`;
 const set=`$phase='SET';$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($p,$acl);`;
 const check=`$phase='CHECK';$acl=[IO.Directory]::GetAccessControl($p);if(!$acl.AreAccessRulesProtected){throw 'ACL_INHERITANCE'};if(!$acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid)){throw 'ACL_OWNER'};$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);if($rules.Count -ne 1 -or !$rules[0].IdentityReference.Equals($sid) -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'ACL_MISMATCH'};`;
 const end=`}catch{[Console]::Error.WriteLine('REMOTEDESK_ACL_'+$phase+'_'+$_.Exception.GetType().Name);exit 1}`;
 try{await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(prelude+(create?set:'')+check+end,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:16384});}catch(e){const code=/REMOTEDESK_ACL_([A-Z]+)_(\w+)/.exec(e.stderr??'');throw new Fault('PRIVATE_DIRECTORY_ACL_FAILED'+(code?'_'+code[1]+'_'+code[2]:''));}
}
