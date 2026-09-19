# Build script: converts assests/icons/sunflower.png -> assests/icons/app-icon.ico
# and produces a Windows NSIS installer + Portable build.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1
#
# Requirements:
#   - Windows + PowerShell 5+ (.NET Framework System.Drawing built-in)
#   - node_modules installed (`npm install` already ran via setup.sh)

$ErrorActionPreference = "Stop"

# PowerShell on Windows defaults to the legacy system codepage (GBK on zh-CN
# systems), which mangles non-ASCII path literals like "向日葵" inside
# Join-Path. Switch the active codepage to 65001 (UTF-8) BEFORE any string
# literal with non-ASCII characters is parsed, then also rewire stdout/stderr.
chcp 65001 | Out-Null
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $RepoRoot

# Use Chinese mirrors so the build works without direct access to github.com.
# - ELECTRON_MIRROR:         where electron-builder downloads Electron binaries
# - ELECTRON_BUILDER_BINARIES_MIRROR: where it downloads electron-builder's own binaries (app-builder, etc.)
# These are read by electron-builder / app-builder at child-process start.
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
Write-Host ("[env] ELECTRON_MIRROR = " + $env:ELECTRON_MIRROR) -ForegroundColor DarkCyan

# Try to grant SeCreateSymbolicLinkPrivilege in this process so that
# 7-Zip can extract the darwin/*.dylib symlinks that ship inside
# winCodeSign-*.7z. Without this, the build aborts with exit 2 on
# accounts that lack the privilege.
try {
  & (Join-Path $RepoRoot "scripts\enable-symlink.ps1")
} catch {
  Write-Host ("[enable-symlink] " + $_.Exception.Message) -ForegroundColor Yellow
}

$SrcPng = Join-Path $RepoRoot "assests/icons/sunflower.png"
$OutIco = Join-Path $RepoRoot "assests/icons/app-icon.ico"

if (-not (Test-Path $SrcPng)) {
  throw "Source icon not found: $SrcPng"
}

Write-Host "[1/3] Converting sunflower.png -> app-icon.ico (multi-size)" -ForegroundColor Cyan

Add-Type -AssemblyName System.Drawing

# Sizes to embed in the .ico. Windows uses these from largest-to-smallest
# depending on the view (start menu, taskbar, alt-tab, installer, uninstaller).
$IconSizes = @(256, 128, 64, 48, 32, 16)

$png = [System.Drawing.Image]::FromFile($SrcPng)
$resized = @()
try {
  foreach ($size in $IconSizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($png, 0, 0, $size, $size)
    } finally {
      $g.Dispose()
    }

    # Encode each size as a PNG byte stream so we can embed PNG-in-ICO
    # (Windows Vista+ supports PNG inside .ico natively).
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $resized += , @{ Size = $size; Bytes = $ms.ToArray() }
    $ms.Dispose()
    $bmp.Dispose()
  }
} finally {
  $png.Dispose()
}

# Build the .ico container:
#   ICONDIR (6 bytes): reserved(2)=0, type(2)=1 (icon), count(2)
#   ICONDIRENTRY x N (16 bytes each): width, height, palette, reserved, planes, bitCount, size, offset
#   then the PNG payloads.
$fs = [System.IO.File]::Create($OutIco)
try {
  $bw = New-Object System.IO.BinaryWriter($fs)
  try {
    # ICONDIR
    $bw.Write([UInt16]0)               # reserved
    $bw.Write([UInt16]1)               # type 1 = icon
    $bw.Write([UInt16]$resized.Count)  # image count

    # Compute offset of first image data
    $headerSize = 6 + (16 * $resized.Count)
    $runningOffset = $headerSize

    foreach ($entry in $resized) {
      $w = if ($entry.Size -ge 256) { 0 } else { $entry.Size }   # 0 means 256 in ICO
      $h = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
      $bw.Write([Byte]$w)
      $bw.Write([Byte]$h)
      $bw.Write([Byte]0)               # palette
      $bw.Write([Byte]0)               # reserved
      $bw.Write([UInt16]1)              # planes
      $bw.Write([UInt16]32)             # bit count
      $bw.Write([UInt32]$entry.Bytes.Length)
      $bw.Write([UInt32]$runningOffset)
      $runningOffset += $entry.Bytes.Length
    }

    foreach ($entry in $resized) {
      $bw.Write($entry.Bytes)
    }
  } finally {
    $bw.Flush()
    $bw.Close()
  }
} finally {
  $fs.Dispose()
}

Write-Host ("    wrote: " + $OutIco) -ForegroundColor Green

Write-Host "[2/3] electron-builder (Windows NSIS + Portable)" -ForegroundColor Cyan

# Pre-extract winCodeSign archives with -snld so symlinks in the darwin/
# subfolder (only needed for macOS signing) don't fail the whole step.
# electron-builder will see the extracted dir already exists and skip its
# own (no -snld) extraction.
$sevenZip = Join-Path $RepoRoot "node_modules/7zip-bin/win/x64/7za.exe"
$cacheRoot = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
if (Test-Path $cacheRoot) {
  Get-ChildItem -Path $cacheRoot -Filter "*.7z" | ForEach-Object {
    $dest = Join-Path $_.DirectoryName $_.BaseName
    if (-not (Test-Path $dest)) {
      Write-Host ("    pre-extracting: " + $_.Name) -ForegroundColor DarkGray
      & $sevenZip x -bd -snld -y $_.FullName "-o$dest" | Out-Null
    }
  }
}

& node_modules/.bin/electron-builder.cmd --win --x64
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit $LASTEXITCODE" }

Write-Host "[3/3] Done. Installer/portable artifacts:" -ForegroundColor Green
Get-ChildItem -Path (Join-Path $RepoRoot "dist") -Filter "*.exe" | ForEach-Object {
  $sizeMb = [Math]::Round($_.Length / 1MB, 1)
  Write-Host ("  - {0}  ({1} MB)" -f $_.FullName, $sizeMb)
}
