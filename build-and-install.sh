#!/usr/bin/env bash
# build-and-install.sh -- macOS: from a fresh clone to a running console, one command.
#
#   bash build-and-install.sh [--no-launch] [--skip-deps] [--dest ~/Applications]
#
# What it does, in order, and says so at every step:
#   1. checks Node 20+ and npm
#   2. installs dependencies (npm ci from the lockfile; npm install if there is none)
#   3. packages the app for this Mac's architecture into release-next/
#   4. quits a running console, keeps the previous app beside the new one as
#      CortexInsight.app.prev, copies the new app into the destination, clears
#      the quarantine flag the browser would otherwise put on a download,
#      re-reads the installed bundle's version to PROVE it, rolls back on a
#      mismatch, deletes staging only after proof, and launches
#
# Where things go afterwards:
#   the app          ~/Applications/CortexInsight.app   (or --dest)
#   your vault       ~/Library/Application Support/cortexinsight/
#   agent tools      ~/.cortexinsight/
#
# The build is not code-signed. Gatekeeper may still ask once: right-click the
# app, Open, Open. This script clears the quarantine attribute on what it
# copies, so a build made here usually opens without that step.
set -euo pipefail
cd "$(dirname "$0")"

LAUNCH=1; DEPS=1; DEST="$HOME/Applications"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-launch) LAUNCH=0 ;;
    --skip-deps) DEPS=0 ;;
    --dest) shift; DEST="$1" ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done

step() { printf '\n  [%s] %s\n' "$1" "$2"; }

step 1 'checking the toolchain'
command -v node >/dev/null || { echo 'Node.js 20 or newer is required: https://nodejs.org'; exit 1; }
NV=$(node -v | sed 's/^v//'); MAJOR=${NV%%.*}
[ "$MAJOR" -ge 20 ] || { echo "Node $NV found; 20 or newer is required"; exit 1; }
echo "    node v$NV   npm v$(npm -v)"

step 2 'dependencies'
if [ "$DEPS" = 0 ] && [ -d node_modules ]; then
  echo '    skipped (--skip-deps)'
elif [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

step 3 'packaging'
VER=$(node -p "require('./package.json').version")
ARCH=$(uname -m)
case "$ARCH" in
  arm64) npm run package:mac; OUT=release-next/CortexInsight-darwin-arm64 ;;
  x86_64) npm run package:mac-x64; OUT=release-next/CortexInsight-darwin-x64 ;;
  *) echo "unsupported architecture: $ARCH"; exit 1 ;;
esac
APP="$OUT/CortexInsight.app"
[ -d "$APP" ] || { echo "packaging reported success but $APP is missing"; exit 1; }
echo "    version $VER for $ARCH"

step 4 'installing'
mkdir -p "$DEST"
LIVE="$DEST/CortexInsight.app"; PREV="$DEST/CortexInsight.app.prev"
CUR=''
[ -d "$LIVE" ] && CUR=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$LIVE/Contents/Info.plist" 2>/dev/null || true)
if pgrep -x CortexInsight >/dev/null 2>&1; then
  osascript -e 'tell application "CortexInsight" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x CortexInsight >/dev/null 2>&1 || break; sleep 1; done
  pkill -x CortexInsight >/dev/null 2>&1 || true
fi
rm -rf "$PREV"
[ -d "$LIVE" ] && mv "$LIVE" "$PREV"
ditto "$APP" "$LIVE"
xattr -dr com.apple.quarantine "$LIVE" 2>/dev/null || true
INSTALLED=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$LIVE/Contents/Info.plist" 2>/dev/null || true)
if [ "$INSTALLED" != "$VER" ]; then
  echo "    installed bundle reports v$INSTALLED, expected v$VER -- rolling back"
  rm -rf "$LIVE"
  [ -d "$PREV" ] && mv "$PREV" "$LIVE"
  exit 1
fi
rm -rf release-next
if [ -n "$CUR" ]; then echo "    INSTALLED v$CUR -> v$INSTALLED   rollback at: $PREV"; else echo "    INSTALLED v$INSTALLED"; fi

if [ "$LAUNCH" = 1 ]; then open "$LIVE"; fi
printf '\n  DONE.\n'
echo "    app    : $LIVE"
echo "    vault  : $HOME/Library/Application Support/cortexinsight/"
echo '    first run: the gate asks you to set a passphrase; then set the fleet path on Config if none was discovered'
echo '    docs   : docs/README.md  (or type /help on Command)'
echo
