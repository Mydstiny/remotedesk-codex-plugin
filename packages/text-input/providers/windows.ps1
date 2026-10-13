Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RemoteTextDesktop {
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
 [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int size,out int needed);
 public static string Name(IntPtr desktop) { int needed; var name=new StringBuilder(256); return GetUserObjectInformation(desktop,2,name,512,out needed) ? name.ToString() : ""; }
}
'@
[void][RemoteTextDesktop]::SetProcessDpiAwarenessContext([IntPtr](-4))
function Rect($r) { return @{ x=$r.Left; y=$r.Top; width=$r.Width; height=$r.Height } }
function SnapshotInner {
 $desktop=[RemoteTextDesktop]::Name([RemoteTextDesktop]::GetThreadDesktop([RemoteTextDesktop]::GetCurrentThreadId()))
 $input=[RemoteTextDesktop]::OpenInputDesktop(0,$false,0x0001)
 if ($input -eq [IntPtr]::Zero) { return @{available=$false;reason='locked'} }
 try { if ([RemoteTextDesktop]::Name($input) -ne $desktop) { return @{available=$false;reason='locked'} } }
 finally { [void][RemoteTextDesktop]::CloseDesktop($input) }
 $desktopId='windows:'+([Diagnostics.Process]::GetCurrentProcess().SessionId)+':'+$desktop
 $captures=@([Windows.Forms.Screen]::AllScreens | ForEach-Object { Rect $_.Bounds })
 if ($captures.Count -eq 0 -or $captures.Count -gt 32) { return @{available=$false;reason='unsupported'} }
 $full=Rect ([Windows.Forms.SystemInformation]::VirtualScreen)
 $e=[Windows.Automation.AutomationElement]::FocusedElement
 if ($null -eq $e) {
   return @{available=$true;desktopId=$desktopId;rdpSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;
     coordinateUnit='physicalPx';captureRects=$captures;desktopRect=$full;focusKind='nonText';editable=$false}
 }
 $root=$e; $foreground=[RemoteTextDesktop]::GetForegroundWindow().ToInt64(); $matched=$false
 for ($i=0;$i -lt 16 -and $null -ne $root;$i++) {
   if ($root.Current.NativeWindowHandle -eq $foreground) { $matched=$true; break }
   $root=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($root)
 }
 if (!$matched) { return @{available=$false;reason='unavailable'} }
 $value=$null; $text=$null; $readonly=$true; $readonlyKnown=$false; $editable=$false; $caret=$null
 if ($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$value)) {
   $readonly=$value.Current.IsReadOnly; $readonlyKnown=$true; $editable=!$readonly
 }
 if ($e.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$text)) {
   $ranges=$text.GetSelection()
   if ($ranges.Length -eq 1) {
     $range=$ranges[0]
     $ro=$range.GetAttributeValue([Windows.Automation.TextPattern]::IsReadOnlyAttribute)
     if ($ro -is [bool]) { $readonly=$ro; $readonlyKnown=$true; $editable=!$ro }
     if ($range.CompareEndpoints([Windows.Automation.TextPatternRangeEndpoint]::Start,$range,[Windows.Automation.TextPatternRangeEndpoint]::End) -eq 0) {
       $bounds=$range.GetBoundingRectangles()
       if ($bounds.Length -eq 4) { $caret=@{x=$bounds[0];y=$bounds[1];width=$bounds[2];height=$bounds[3]} }
     }
   }
 }
 $type=$e.Current.ControlType
 $focusKind=if($editable){'editable'}elseif($readonlyKnown){'readOnly'}elseif(@(
   [Windows.Automation.ControlType]::Button,[Windows.Automation.ControlType]::CheckBox,
   [Windows.Automation.ControlType]::RadioButton,[Windows.Automation.ControlType]::MenuItem,
   [Windows.Automation.ControlType]::Hyperlink) -contains $type){'nonText'}else{'unknown'}
 return @{available=$true;desktopId=$desktopId;rdpSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;coordinateUnit='physicalPx';
   captureRects=$captures;desktopRect=$full;focusKind=$focusKind;
   focusToken=($e.GetRuntimeId() -join ':');editable=$editable;readOnly=$readonly;
   enabled=$e.Current.IsEnabled;visible=(!$e.Current.IsOffscreen);
   inputKind=$(if($e.Current.IsPassword){'password'}else{'text'});
   controlRect=(Rect $e.Current.BoundingRectangle);caretRect=$caret}
}
function Snapshot {
 $previous=[RemoteTextDesktop]::SetThreadDpiAwarenessContext([IntPtr](-4))
 if ($previous -eq [IntPtr]::Zero) { return @{available=$false;reason='unsupported'} }
 try {
   if (![RemoteTextDesktop]::AreDpiAwarenessContextsEqual([RemoteTextDesktop]::GetThreadDpiAwarenessContext(),[IntPtr](-4))) {
     return @{available=$false;reason='unsupported'}
   }
   SnapshotInner
 } finally { [void][RemoteTextDesktop]::SetThreadDpiAwarenessContext($previous) }
}
while ($null -ne [Console]::ReadLine()) {
 try { $value=Snapshot; [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 5)) }
 catch { [Console]::WriteLine('{"available":false,"reason":"unavailable"}') }
}
