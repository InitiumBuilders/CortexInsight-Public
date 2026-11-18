# Sync-And-Launch.ps1 -- check the relay and the fleet tree, then open CortexInsight.
# Right-click -> "Run with PowerShell", or:
#   powershell -ExecutionPolicy Bypass -File .\Sync-And-Launch.ps1
#
# ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as
# ANSI; a tick or an arrow glyph then decodes to a stray quote character and the
# whole file fails to parse. Do not add symbols here.
$ErrorActionPreference = 'SilentlyContinue'
Write-Host ''
Write-Host '  CortexInsight :: syncing with the fleet' -ForegroundColor Magenta
Write-Host ''

# 1) The loopback relay (the agents' single door).
function Test-Relay {
  try { (Invoke-WebRequest -Uri 'http://127.0.0.1:8788/health' -TimeoutSec 3 -UseBasicParsing).Content } catch { $null }
}
$h = Test-Relay
if ($h -and $h -match 'ok') {
  Write-Host "  [ok] relay live on 127.0.0.1:8788  ($h)" -ForegroundColor Green
} else {
  Write-Host '  [..] relay not responding; starting cortex-mouth-proxy.service via WSL' -ForegroundColor Yellow
  wsl -e systemctl --user start cortex-mouth-proxy.service 2>$null
  Start-Sleep -Seconds 2
  $h = Test-Relay
  if ($h -and $h -match 'ok') { Write-Host "  [ok] relay started ($h)" -ForegroundColor Green }
  else { Write-Host '  [!!] relay still down. The app opens and shows it offline; Command waits until the proxy is up.' -ForegroundColor Red }
}

# 2) The fleet tree (read-only state source), wherever WSL keeps the home.
wsl.exe -e sh -c 'ls -d "$HOME"/*/logs/interactions >/dev/null 2>&1' 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host '  [ok] fleet tree reachable (read-only)' -ForegroundColor Green
} else {
  Write-Host '  [!!] fleet tree not reachable. Is WSL running? (wsl -d <distro>)' -ForegroundColor Red
}

# 3) Launch: the packaged exe if present, else from source.
$exe = Join-Path $PSScriptRoot 'release\CortexInsight-win32-x64\CortexInsight.exe'
if (Test-Path $exe) {
  Write-Host ''
  Write-Host '  -> launching CortexInsight.exe' -ForegroundColor Magenta
  Start-Process $exe
} else {
  Write-Host ''
  Write-Host '  -> launching from source (npm start)' -ForegroundColor Magenta
  Start-Process -FilePath 'npm' -ArgumentList 'start' -WorkingDirectory $PSScriptRoot
}
