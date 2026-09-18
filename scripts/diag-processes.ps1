# diag-processes.ps1 — show the real process tree for the app + python,
# to distinguish "normal Electron child processes" from "duplicate instances".
$ErrorActionPreference = "Continue"

$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like '*助手*' -or $_.Name -like 'python*' -or $_.Name -like '*OpenCluely*'
}

Write-Host ("Found " + $procs.Count + " matching process(es):")
foreach ($p in $procs) {
  $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
  $parentDesc = if ($parent) { $parent.Name + " (" + $parent.ProcessId + ")" } else { "<dead pid " + $p.ParentProcessId + ">" }
  $path = if ($p.ExecutablePath) { $p.ExecutablePath } else { "<no path>" }
  Write-Host ("PID " + $p.ProcessId + "  PPID " + $p.ParentProcessId + "  parent=" + $parentDesc)
  Write-Host ("      name=" + $p.Name)
  Write-Host ("      path=" + $path)
  $cl = $p.CommandLine
  if ($cl -and $cl.Length -gt 220) { $cl = $cl.Substring(0, 220) + "..." }
  Write-Host ("      cmd =" + $cl)
  Write-Host ""
}

# Count grouped by exe path (one installed app = 1 path with many PIDs)
Write-Host "---- grouped by executable path ----"
$procs | Group-Object ExecutablePath | ForEach-Object {
  Write-Host ($_.Count.ToString().PadLeft(3) + "x  " + $_.Name)
}
