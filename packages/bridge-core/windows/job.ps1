param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
# An inherited Windows Job Object owns every engine descendant. CREATE_SUSPENDED
# prevents the child from running before assignment; breakaway is not enabled.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RemoteDeskJob {
 [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long a,b; public uint LimitFlags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] public struct EXTENDED { public BASIC Basic; public IO_COUNTERS Io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUP { public uint cb; public string reserved, desktop, title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reserved3,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUP start,out PROCESS process);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint result);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint result);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static int Run(string command,string args) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero)throw new Exception("JOB_CREATE_FAILED");
  PROCESS p=new PROCESS(); IntPtr data=IntPtr.Zero;
  try {
   EXTENDED limits=new EXTENDED(); limits.Basic.LimitFlags=0x2000;
   data=Marshal.AllocHGlobal(Marshal.SizeOf(limits));Marshal.StructureToPtr(limits,data,false);
   if(!SetInformationJobObject(job,9,data,(uint)Marshal.SizeOf(limits)))throw new Exception("JOB_LIMIT_FAILED");
   STARTUP s=new STARTUP();s.cb=(uint)Marshal.SizeOf(s);s.flags=0x100;
   s.input=GetStdHandle(-10);s.output=GetStdHandle(-11);s.error=GetStdHandle(-12);
   if(!SetHandleInformation(s.input,1,1)||!SetHandleInformation(s.output,1,1)||!SetHandleInformation(s.error,1,1))throw new Exception("JOB_STDIO_FAILED");
   if(!CreateProcess(command,new StringBuilder(args),IntPtr.Zero,IntPtr.Zero,true,0x00000004|0x08000000,IntPtr.Zero,null,ref s,out p))throw new Exception("JOB_PROCESS_FAILED");
   if(!AssignProcessToJobObject(job,p.process)){TerminateProcess(p.process,125);throw new Exception("JOB_ASSIGN_FAILED");}
   if(ResumeThread(p.thread)==0xffffffff){TerminateProcess(p.process,125);throw new Exception("JOB_RESUME_FAILED");}
   WaitForSingleObject(p.process,0xffffffff);uint result;GetExitCodeProcess(p.process,out result);return (int)result;
  } finally { if(p.thread!=IntPtr.Zero)CloseHandle(p.thread);if(p.process!=IntPtr.Zero)CloseHandle(p.process);if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);CloseHandle(job); }
 }
}
'@
try {
 $value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
 exit [RemoteDeskJob]::Run([string]$value.command,[string]$value.commandLine)
} catch { [Console]::Error.WriteLine('REMOTEDESK_JOB_FAILED'); exit 125 }
