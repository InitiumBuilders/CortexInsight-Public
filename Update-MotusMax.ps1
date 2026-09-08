# Update-MotusMax.ps1 -- kept for the name people know. It now hands off to
# scripts\install.ps1, which swaps a staged build in, proves the version by
# re-reading the binary, rolls back on failure, and keeps the previous build.
#
#   powershell -ExecutionPolicy Bypass -File .\Update-MotusMax.ps1 [-Expect 3.63.0] [-NoLaunch] [-Shortcut]
#
# Stage a build first with `npm run package` (or run Build-And-Install.ps1 to
# do everything in one go). ASCII only, deliberately: Windows PowerShell 5.1
# reads a BOM-less UTF-8 .ps1 as ANSI and a stray glyph breaks the parse.
param(
  [string]$Expect = '',
  [switch]$NoLaunch,
  [switch]$Shortcut
)
$ErrorActionPreference = 'Stop'
# $PSBoundParameters is a dictionary, so the splat binds by NAME
& (Join-Path $PSScriptRoot 'scripts\install.ps1') @PSBoundParameters
