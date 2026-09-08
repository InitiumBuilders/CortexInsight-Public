# Update-MotusMax.ps1 -- swap in the staged build and PROVE it happened.
#
# WHY THIS WAS REWRITTEN: the old version did the job and said almost nothing.
# It closed the app, moved a folder, relaunched -- and from the outside that is
# indistinguishable from "nothing ran". August ran it, got v3.20.0, and had no
# way to know. A tool that succeeds silently has failed at half its job.
#
# It now: reports the version you are ON, the version you are MOVING TO, does
# the swap, RE-READS the binary to confirm, and tells you plainly if you were
# already up to date instead of throwing an error that reads like a failure.
#
# ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1
# as ANSI, so a tick or an arrow glyph becomes mojibake that can break string
# quoting and fail the whole script at parse time. Do not add symbols here.
#
# Your data is untouched: state lives in %APPDATA%\cortexinsight, never here.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$live = Join-Path $root 'release\CortexInsight-win32-x64'
$next = Join-Path $root 'release-next\CortexInsight-win32-x64'
$prev = Join-Path $root 'release\CortexInsight-win32-x64.prev'
$liveExe = Join-Path $live 'CortexInsight.exe'
$nextExe = Join-Path $next 'CortexInsight.exe'

function Ver($p) { if (Test-Path $p) { (Get-Item $p).VersionInfo.FileVersion } else { $null } }

Write-Host ''
Write-Host '  MOTUS MAX / CORTEXINSIGHT UPDATER' -ForegroundColor Cyan
Write-Host '  ---------------------------------' -ForegroundColor DarkGray

$curVer = Ver $liveExe
if ($curVer) { Write-Host "  You are on   : v$curVer" -ForegroundColor Gray }
else { Write-Host '  You are on   : (no installed build found)' -ForegroundColor Yellow }

# Nothing staged? That is usually GOOD NEWS, not an error.
if (-not (Test-Path $nextExe)) {
  Write-Host '  Staged build : none' -ForegroundColor Gray
  Write-Host ''
  Write-Host "  OK - nothing to install. You are already running v$curVer." -ForegroundColor Green
  Write-Host '  (A staged build appears at release-next\ when a new one is built.)' -ForegroundColor DarkGray
  Write-Host ''
  exit 0
}

$newVer = Ver $nextExe
Write-Host "  Staged build : v$newVer" -ForegroundColor Gray
if ($curVer -eq $newVer) {
  Write-Host ''
  Write-Host "  Already on v$curVer - reinstalling it anyway so the folder is clean." -ForegroundColor Green
}
Write-Host ''

Write-Host '  Closing CortexInsight...' -ForegroundColor Cyan
$was = (Get-Process -Name 'CortexInsight' -ErrorAction SilentlyContinue | Measure-Object).Count
Get-Process -Name 'CortexInsight' -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.CloseMainWindow() | Out-Null } catch {}
}
Start-Sleep -Seconds 2
Get-Process -Name 'CortexInsight' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Host "    closed ($was process(es))" -ForegroundColor DarkGray

Write-Host "  Installing v$newVer..." -ForegroundColor Cyan
if (Test-Path $prev) { Remove-Item $prev -Recurse -Force }
if (Test-Path $live) { Rename-Item $live $prev }
Move-Item $next $live
Remove-Item (Join-Path $root 'release-next') -Recurse -Force -ErrorAction SilentlyContinue

# PROVE IT. Re-read the binary that is now installed.
$installed = Ver $liveExe
if ($installed -ne $newVer) {
  Write-Host ''
  Write-Host "  FAILED - the installed binary reports v$installed, expected v$newVer." -ForegroundColor Red
  Write-Host "  Your previous build is safe at: $prev" -ForegroundColor Yellow
  exit 1
}

Write-Host '  Launching...' -ForegroundColor Cyan
Start-Process $liveExe
Start-Sleep -Seconds 3
$now = (Get-Process -Name 'CortexInsight' -ErrorAction SilentlyContinue | Measure-Object).Count

Write-Host ''
if ($curVer -and $curVer -ne $newVer) {
  Write-Host "  UPDATED   v$curVer  ->  v$installed" -ForegroundColor Green
} else {
  Write-Host "  INSTALLED v$installed" -ForegroundColor Green
}
Write-Host "    running: $now process(es)" -ForegroundColor DarkGray
Write-Host "    rollback kept at: $prev" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  MotusLive : nav rail -> MotusLive. Pick a DJ, tick what the world may see, GO LIVE.' -ForegroundColor Yellow
Write-Host '  Motus Max : press and hold to arm -> the HUD turns GOLD -> Drive Now.' -ForegroundColor Yellow
Write-Host ''
