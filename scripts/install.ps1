# scripts\install.ps1 -- swap a staged build into place and PROVE it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Expect 3.63.0] [-NoLaunch] [-Shortcut]
#
# Expects a packaged build at release-next\CortexInsight-win32-x64\ (what
# `npm run package` produces). Closes a running console, polls for exit,
# swaps the folders with retries (Windows can hold a directory handle for a
# moment after the last process exits), re-reads the installed binary to
# prove the version, rolls back if the proof fails, and deletes the staging
# folder only after proof. The previous build stays beside the live one as
# CortexInsight-win32-x64.prev until the next install.
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as ANSI, and a
# stray glyph decodes to a quote that breaks the parse. Never SilentlyContinue.
param(
  [string]$Expect = '',
  [switch]$NoLaunch,
  [switch]$Shortcut
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$live = Join-Path $root 'release\CortexInsight-win32-x64'
$next = Join-Path $root 'release-next\CortexInsight-win32-x64'
$prev = Join-Path $root 'release\CortexInsight-win32-x64.prev'
$liveExe = Join-Path $live 'CortexInsight.exe'
$nextExe = Join-Path $next 'CortexInsight.exe'
function Ver($p) { if (Test-Path $p) { (Get-Item $p).VersionInfo.FileVersion } else { $null } }

$cur = Ver $liveExe
$staged = Ver $nextExe
if (-not $staged) { throw "nothing staged at $nextExe -- run `npm run package` first" }
if (-not $Expect) { $Expect = $staged }
if ($cur) { "on: v$cur   staged: v$staged   expect: v$Expect" } else { "on: (nothing installed)   staged: v$staged   expect: v$Expect" }
if ($staged -ne $Expect) { throw "staged build reports v$staged, expected v$Expect -- refusing" }

# close, then POLL for exit (a held handle is transient, not an error)
Get-Process -Name CortexInsight -ErrorAction SilentlyContinue | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
$t = 0
while ((Get-Process -Name CortexInsight -ErrorAction SilentlyContinue) -and $t -lt 20) { Start-Sleep -Seconds 1; $t++ }
Get-Process -Name CortexInsight -ErrorAction SilentlyContinue | Stop-Process -Force
$t = 0
while ((Get-Process -Name CortexInsight -ErrorAction SilentlyContinue) -and $t -lt 10) { Start-Sleep -Seconds 1; $t++ }
"closed after ${t}s"

# swap with retries
New-Item -ItemType Directory -Force (Join-Path $root 'release') | Out-Null
if (Test-Path $prev) { Remove-Item $prev -Recurse -Force }
$ok = $false
for ($i = 1; $i -le 12; $i++) {
  try {
    if (Test-Path $live) { Rename-Item $live $prev }
    Move-Item $next $live
    $ok = $true; break
  } catch { "rename attempt $i failed: $($_.Exception.Message)"; Start-Sleep -Seconds 2 }
}
if (-not $ok) { throw 'could not swap the folders after 12 attempts -- nothing changed' }

# PROVE, or ROLL BACK
$installed = Ver $liveExe
if ($installed -ne $Expect) {
  "installed binary reports v$installed, expected v$Expect -- rolling back"
  if (Test-Path $live) { Move-Item $live $next }
  if (Test-Path $prev) { Rename-Item $prev $live }
  throw "rolled back to v$(Ver $liveExe)"
}
# staging is deleted ONLY after verified success
Remove-Item (Join-Path $root 'release-next') -Recurse -Force

if ($Shortcut) {
  try {
    $desk = [Environment]::GetFolderPath('Desktop')
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut((Join-Path $desk 'CortexInsight.lnk'))
    $sc.TargetPath = $liveExe
    $sc.WorkingDirectory = $live
    $sc.IconLocation = $liveExe
    $sc.Description = 'CortexInsight'
    $sc.Save()
    "shortcut: $(Join-Path $desk 'CortexInsight.lnk')"
  } catch { "shortcut not created: $($_.Exception.Message)" }
}

if ($NoLaunch) {
  if ($cur) { "INSTALLED v$cur -> v$installed   (not launched)   rollback at: $prev" } else { "INSTALLED v$installed   (not launched)" }
  exit 0
}
Start-Process $liveExe
Start-Sleep -Seconds 4
$n = (Get-Process -Name CortexInsight -ErrorAction SilentlyContinue | Measure-Object).Count
$path = (Get-Process -Name CortexInsight -ErrorAction SilentlyContinue | Select-Object -First 1).Path
if ($cur) { "INSTALLED v$cur -> v$installed   running: $n process(es) from $path   rollback at: $prev" }
else { "INSTALLED v$installed   running: $n process(es) from $path" }
