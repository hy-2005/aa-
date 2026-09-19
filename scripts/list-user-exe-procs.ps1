# Enumerate non-system exe processes (CIM avoids Path access limits)
Get-CimInstance Win32_Process -Filter "Name like '%.exe'" | ForEach-Object {
  $p = $_.ExecutablePath
  if ($p -and ($p -notlike 'C:\Windows\*') -and ($p -notlike 'C:\Program Files\WindowsApps\*')) {
    "{0,7}  {1}" -f $_.ProcessId, $p
  }
}