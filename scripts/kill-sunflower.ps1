# Kill all installed sunflower-assistant instances (old broken build)
Get-CimInstance Win32_Process -Filter "Name like '%.exe'" | Where-Object {
  $_.ExecutablePath -like '*sunflower-assistant*'
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
}
Start-Sleep 1
$left = (Get-CimInstance Win32_Process -Filter "Name like '%.exe'" | Where-Object {
  $_.ExecutablePath -like '*sunflower-assistant*'
} | Measure-Object).Count
"remaining=$left"