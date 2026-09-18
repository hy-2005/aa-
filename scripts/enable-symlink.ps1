# enable-symlink.ps1 - enable SeCreateSymbolicLinkPrivilege for the current
# PowerShell process so 7-Zip can extract symlinks from winCodeSign-*.7z
# without exiting 2 on a normal Windows user account.
#
# No-op if the privilege is already enabled.
# Must be run from an elevated PowerShell; otherwise prints a hint.

$ErrorActionPreference = "Stop"

$signature = @"
using System;
using System.Runtime.InteropServices;

public class TokPriv {
  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  public struct TOKEN_PRIVILEGES {
    public int PrivilegeCount;
    public long Luid;
    public int Attributes;
  }

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out long lpLuid);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges, ref TOKEN_PRIVILEGES NewState, int BufferLength, IntPtr PreviousState, IntPtr ReturnLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetCurrentProcess();

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
}
"@

Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue

$TOKEN_ADJUST_PRIVILEGES = 0x0020
$TOKEN_QUERY = 0x0008
$SE_PRIVILEGE_ENABLED = 0x00000002
$privName = "SeCreateSymbolicLinkPrivilege"

$luid = 0
if (-not [TokPriv]::LookupPrivilegeValue($null, $privName, [ref]$luid)) {
  throw ("LookupPrivilegeValue failed: " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

$tp = New-Object TokPriv+TOKEN_PRIVILEGES
$tp.PrivilegeCount = 1
$tp.Luid = $luid
$tp.Attributes = $SE_PRIVILEGE_ENABLED

$hToken = [IntPtr]::Zero
if (-not [TokPriv]::OpenProcessToken([TokPriv]::GetCurrentProcess(), ($TOKEN_ADJUST_PRIVILEGES -bor $TOKEN_QUERY), [ref]$hToken)) {
  throw ("OpenProcessToken failed: " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

if (-not [TokPriv]::AdjustTokenPrivileges($hToken, $false, [ref]$tp, 0, [IntPtr]::Zero, [IntPtr]::Zero)) {
  throw ("AdjustTokenPrivileges failed: " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($err -eq 1300) {
  Write-Host "[enable-symlink] SeCreateSymbolicLinkPrivilege is not held by this account (error 1300 = ERROR_NOT_ALL_ASSIGNED)." -ForegroundColor Yellow
  Write-Host "[enable-symlink] To create symlinks on Windows you either need:" -ForegroundColor Yellow
  Write-Host "  - Developer Mode enabled (Settings -> Privacy & security -> For developers)" -ForegroundColor Yellow
  Write-Host "  - OR run this PowerShell as Administrator" -ForegroundColor Yellow
  Write-Host "[enable-symlink] The build will likely fail on winCodeSign extraction. Continuing anyway." -ForegroundColor Yellow
} else {
  Write-Host "[enable-symlink] SeCreateSymbolicLinkPrivilege enabled for current process." -ForegroundColor Green
}
