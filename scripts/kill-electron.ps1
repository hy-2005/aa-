Get-Process -Name 'electron*','OpenCluely*' -ErrorAction SilentlyContinue |
  ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Write-Host ('killed ' + $_.ProcessName + ' PID ' + $_.Id) } catch {} }
