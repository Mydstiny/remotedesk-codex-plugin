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
 const prelude=`$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;`;
 const set=`$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl;`;
 const check=`$acl=Get-Acl -LiteralPath $p;if(!$acl.AreAccessRulesProtected){throw 'ACL_INHERITANCE'};$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);if($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl'){throw 'ACL_MISMATCH'};`;
 try{await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(prelude+(create?set:'')+check,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:1000});}catch{throw new Fault('PRIVATE_DIRECTORY_ACL_FAILED');}
}
