# repro-console.ps1 — launch the portable exe and catch the black console window
# red-handed: enumerate every visible top-level window with its class name and
# owner PID, then dump the app process tree. Console windows are always class
# "ConsoleWindowClass" hosted by conhost.exe whose PARENT is the console app.
$ErrorActionPreference = "Continue"

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static List<string> Results = new List<string>();
  public static void Run() {
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var txt = new StringBuilder(256); GetWindowText(h, txt, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      Results.Add(cls.ToString() + "|" + pid.ToString() + "|" + txt.ToString());
      return true;
    }, IntPtr.Zero);
  }
}
"@
[WinEnum]::Run()

# 1) Any console-class windows right now (baseline before launch)
Write-Host "=== BEFORE launch: ConsoleWindowClass windows ==="
$found = $false
foreach ($r in [WinEnum]::Results) {
  $parts = $r.Split('|')
  if ($parts[0] -eq 'ConsoleWindowClass') { Write-Host $r; $found = $true }
}
if (-not $found) { Write-Host "(none)" }

# 2) Launch the portable exe
$dist = "D:\code\笔试软件\OpenCluely\dist"
$exe = Get-ChildItem -Path $dist -Filter "*Portable*.exe" | Select-Object -First 1
if (-not $exe) { Write-Host "NO PORTABLE EXE FOUND"; exit 1 }
Write-Host ("=== Launching: " + $exe.FullName + " ===")
Start-Process -FilePath $exe.FullName
Write-Host "Waiting 25s for extraction + startup..."
Start-Sleep -Seconds 25

# 3) Re-enumerate windows
[WinEnum]::Results.Clear()
[WinEnum]::Run()
Write-Host ""
Write-Host "=== AFTER launch: ALL visible windows with class|pid|title ==="
foreach ($r in [WinEnum]::Results) { Write-Host $r }

# 4) Process tree for app + console hosts
Write-Host ""
Write-Host "=== Process tree (app / conhost / cmd / powershell / python) ==="
$names = @('conhost','cmd','powershell','python','pythonw','OpenConsole','WindowsTerminal')
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -like '*助手*') -or ($names -contains ($_.Name -replace '\.exe$',''))
}
foreach ($p in $procs) {
  $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
  $parentDesc = if ($parent) { $parent.Name } else { "<dead>" }
  $path = if ($p.ExecutablePath) { $p.ExecutablePath } else { "<no path>" }
  if ($path.Length -gt 90) { $path = "..." + $path.Substring($path.Length - 90) }
  Write-Host ("PID " + $p.ProcessId + " <- " + $parentDesc + "  " + $p.Name + "  " + $path)
}

Write-Host ""
Write-Host "DONE - processes left running for inspection"
