# check-pe-subsystem.ps1 — read the PE header Subsystem field of the built exes.
# 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI (no console), 3 = IMAGE_SUBSYSTEM_WINDOWS_CUI (console / black window).
$ErrorActionPreference = "Stop"

function Get-PESubsystem([string]$path) {
  if (-not (Test-Path $path)) { return "MISSING" }
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $br = New-Object System.IO.BinaryReader($fs)
    $null = $fs.Seek(0x3C, 'Begin')
    $peOff = $br.ReadInt32()
    $null = $fs.Seek($peOff, 'Begin')
    $sig = $br.ReadBytes(4)  # "PE\0\0"
    if ($sig[0] -ne 0x50 -or $sig[1] -ne 0x45) { return "NOT-PE" }
    # PE sig (4) + COFF header (20) + optional header offset of Subsystem (68)
    $null = $fs.Seek($peOff + 4 + 20 + 68, 'Begin')
    $subsystem = $br.ReadUInt16()
    switch ($subsystem) {
      2 { return "2 (GUI - no console)" }
      3 { return "3 (CONSOLE - black window!)" }
      default { return "$subsystem (other)" }
    }
  } finally {
    $fs.Dispose()
  }
}

$targets = @(
  "D:\code\笔试软件\OpenCluely\dist\windows个人助手-Portable-1.0.0-x64.exe",
  "D:\code\笔试软件\OpenCluely\dist\windows个人助手-Setup-1.0.0-x64.exe",
  "D:\code\笔试软件\OpenCluely\dist\win-unpacked\windows个人助手.exe"
)
foreach ($t in $targets) {
  Write-Host ((Split-Path $t -Leaf).PadRight(45) + " -> " + (Get-PESubsystem $t))
}
