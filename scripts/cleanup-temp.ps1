# cleanup-temp.ps1 — kill leftover "windows个人助手.exe" processes and
# remove the NSIS staging directories under %LOCALAPPDATA%\Temp that the
# installer creates while extracting the bundled app.
#
# Why this exists: NSIS extracts the embedded .exe to a per-install temp
# directory before launching it. If a previous install was force-killed
# (the user closed the window or the installer crashed), the temp .exe
# stays running and the staging directory stays on disk, producing the
# "black cmd window" the user sees on a fresh install.
#
# This script:
#   1. kills any running process whose executable is named
#      "windows个人助手.exe" OR whose path lives inside a Temp staging
#      directory (the only place NSIS puts it),
#   2. deletes the matching %LOCALAPPDATA%\Temp\<hash>\ directories,
#   3. leaves every other process alone (no broad "killing everything with
#      'windows' in the title" — that was a bug in v1 and almost killed
#      TextInputHost.exe).

$ErrorActionPreference = "Stop"

$exeName = "windows个人助手.exe"
$tempRoots = @(
  (Join-Path $env:LOCALAPPDATA "Temp")
)

$killed = 0
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $proc = $_
  $name = $proc.ProcessName
  $path = $proc.Path
  $isTarget = $false
  $reason = ""

  if ($name -ieq "windows个人助手") {
    $isTarget = $true
    $reason = "process name match"
  } elseif ($path -and $path -like "*Temp*${exeName}") {
    $isTarget = $true
    $reason = "NSIS staging path match"
  } elseif ($path -and $path -like "*Temp*windows*助手*") {
    $isTarget = $true
    $reason = "Temp path + brand match"
  }

  if ($isTarget) {
    Write-Host ("Killing PID " + $proc.Id + " (" + $reason + "): " + $path)
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; $script:killed++ } catch {
      Write-Host ("  -> failed: " + $_.Exception.Message)
    }
  }
}

# Remove NSIS staging dirs whose only contents are our extracted exe.
# Pattern: <tempRoot>\<6+char random>\windows个人助手.exe (possibly with
# sibling files from the install).
$removedDirs = 0
foreach ($root in $tempRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $dir = $_.FullName
    $candidate = Join-Path $dir $exeName
    if (Test-Path $candidate) {
      try {
        Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
        Write-Host ("Removed staging dir: " + $dir)
        $script:removedDirs++
      } catch {
        Write-Host ("  -> could not remove " + $dir + ": " + $_.Exception.Message)
      }
    }
  }
}

Write-Host ("")
Write-Host ("Summary: killed " + $killed + " process(es), removed " + $removedDirs + " staging dir(s).")
