# Build-And-Install.ps1 -- from a fresh clone to a running console, one command.
#
#   powershell -ExecutionPolicy Bypass -File .\Build-And-Install.ps1 [-NoLaunch] [-NoShortcut] [-SkipInstallDeps]
#
# What it does, in order, and says so at every step:
#   1. checks Node 20+ and npm are on PATH
#   2. installs dependencies (npm ci from the lockfile; npm install if there is none)
#   3. packages the app into release-next\ (npm run package)
#   4. hands the staged build to scripts\install.ps1, which swaps it in, proves
#      the version by re-reading the binary, rolls back on failure, keeps the
#      previous build beside the live one, and launches
#   5. puts a shortcut on the desktop (skip with -NoShortcut)
#
# Where things go afterwards:
#   the app          release\CortexInsight-win32-x64\CortexInsight.exe
#   your vault       %APPDATA%\cortexinsight\  (never inside this folder)
#   agent tools      ~/.cortexinsight/ in the WSL home the fleet path points at
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as ANSI.
param(
  [switch]$NoLaunch,
  [switch]$NoShortcut,
  [switch]$SkipInstallDeps
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Step($n, $msg) { Write-Host ''; Write-Host ("  [{0}] {1}" -f $n, $msg) -ForegroundColor Cyan }

Step 1 'checking the toolchain'
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) { throw 'Node.js 20 or newer (with npm) is required. Install it from https://nodejs.org and reopen this shell.' }
$nv = (& node -v).TrimStart('v')
$major = [int]($nv.Split('.')[0])
if ($major -lt 20) { throw "Node $nv found; 20 or newer is required." }
"    node v$nv   npm v$(& npm -v)"

Step 2 'dependencies'
if ($SkipInstallDeps -and (Test-Path (Join-Path $root 'node_modules'))) {
  '    skipped (-SkipInstallDeps)'
} elseif (Test-Path (Join-Path $root 'package-lock.json')) {
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} else {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

Step 3 'packaging'
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$ver = $pkg.version
"    version $ver"
& npm run package
if ($LASTEXITCODE -ne 0) { throw 'packaging failed' }
$staged = Join-Path $root 'release-next\CortexInsight-win32-x64\CortexInsight.exe'
if (-not (Test-Path $staged)) { throw "packaging reported success but $staged is missing" }

Step 4 'installing'
# a HASHTABLE splat binds by name; an array splat binds by position, which
# handed the installer the literal flag as its version. And never `$args`:
# that is PowerShell's automatic unbound-arguments variable.
$installArgs = @{ Expect = $ver }
if ($NoLaunch) { $installArgs.NoLaunch = $true }
if (-not $NoShortcut) { $installArgs.Shortcut = $true }
& (Join-Path $root 'scripts\install.ps1') @installArgs

Write-Host ''
Write-Host '  DONE.' -ForegroundColor Green
Write-Host "    app    : $(Join-Path $root 'release\CortexInsight-win32-x64\CortexInsight.exe')"
Write-Host "    vault  : $env:APPDATA\cortexinsight\"
Write-Host '    first run: the gate asks you to set a passphrase; then set the fleet path on Config if none was discovered'
Write-Host '    docs   : docs\README.md  (or type /help on Command)'
Write-Host ''
