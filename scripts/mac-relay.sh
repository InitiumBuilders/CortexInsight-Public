#!/usr/bin/env bash
# ============================================================================
#  mac-relay.sh — the loopback relay on a Mac, without systemd.
#
#  On a Linux box the relay is cortex-relay.service and systemd keeps it alive.
#  A Mac has launchd instead, and /bin/bash 3.2, and BSD stat; the relay code in
#  linux/relay runs on all of that unchanged. This script is the missing half:
#  it puts the relay in the fleet tree, starts it, and (if you ask) hands it to
#  launchd so it comes back at every login and after every crash.
#
#  First time, from a clone:
#    bash scripts/mac-relay.sh setup        copies the relay into ~/cortex/relay
#                                           and this script to ~/cortex/bin/cortex
#  Then, from anywhere:
#    cortex relay start|stop|restart|status|logs [-f]
#    cortex relay install|uninstall        start at login via launchd, or stop that
#    cortex doctor                         what is missing, in order
#
#  Env, all optional: CORTEX_ROOT (default ~/cortex), CORTEX_MOUTH_PORT (8788),
#  CORTEX_TOKEN_FILE (~/.claude/cortex-oauth-token).
# ============================================================================
set -uo pipefail

ROOT="${CORTEX_ROOT:-$HOME/cortex}"
RELAY_DIR="$ROOT/relay"
PORT="${CORTEX_MOUTH_PORT:-8788}"
PIDFILE="$ROOT/logs/relay.pid"
SVCLOG="$ROOT/logs/relay-service.log"
TOKEN_FILE="${CORTEX_TOKEN_FILE:-$HOME/.claude/cortex-oauth-token}"
LABEL="com.outlier.cortex-mouth-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
# launchd starts with a bare PATH; claude usually lives in ~/.local/bin or Homebrew
SVC_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
rose()  { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

health() { curl -s -m 3 "http://127.0.0.1:$PORT/health"; }

running_pid() {
  local p; p="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"
}

under_launchd() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

wait_health() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    health >/dev/null && return 0
    sleep 0.5
  done
  return 1
}

# From a clone: the relay files into the tree, this script beside them as `cortex`.
# Re-running it is how a Mac takes a newer relay; a running relay is restarted onto it.
setup() {
  local here src
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  src="$here/../linux/relay"
  [ -r "$src/cortex-mouth.py" ] || { rose "no relay at $src; run setup from a clone of the repo"; return 1; }
  mkdir -p "$RELAY_DIR" "$ROOT/bin" "$ROOT/logs" "$ROOT/agents"
  cp -f "$src"/*.py "$src"/*.sh "$RELAY_DIR/"
  chmod 755 "$RELAY_DIR"/*.py "$RELAY_DIR"/*.sh
  cp -f "$here/mac-relay.sh" "$ROOT/bin/cortex"
  chmod 755 "$ROOT/bin/cortex"
  green "relay installed in $RELAY_DIR; the CLI is $ROOT/bin/cortex"
  if health >/dev/null; then relay_restart; else info "start it with: $ROOT/bin/cortex relay start"; fi
}

relay_start() {
  if health >/dev/null; then green "relay already live on 127.0.0.1:$PORT"; return 0; fi
  if under_launchd; then launchctl kickstart "$DOMAIN/$LABEL"
  else
    mkdir -p "$ROOT/logs"
    # PATH is pinned so a turn finds claude the same way the launchd agent does
    nohup env CORTEX_ROOT="$ROOT" CORTEX_MOUTH_PORT="$PORT" CORTEX_MOUTH_KEY="${CORTEX_MOUTH_KEY:-}" PATH="$SVC_PATH" \
      /usr/bin/python3 -I "$RELAY_DIR/cortex-mouth.py" >>"$SVCLOG" 2>&1 &
    echo $! > "$PIDFILE"
  fi
  if wait_health; then green "relay live on 127.0.0.1:$PORT"; else rose "relay did not answer; see: cortex relay logs"; return 1; fi
}

relay_stop() {
  if under_launchd; then
    # KeepAlive would bring it straight back; stopping for good is uninstall
    info "launchd keeps the relay alive; 'cortex relay uninstall' stops it for good"
    return 0
  fi
  local p; p="$(running_pid)"
  if [ -n "$p" ]; then kill "$p" && rm -f "$PIDFILE" && green "relay stopped"; else info "relay was not running (from this CLI)"; fi
}

relay_restart() {
  if under_launchd; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
    sleep 1
  else
    relay_stop >/dev/null 2>&1
    sleep 1
  fi
  relay_start
}

relay_install() {
  mkdir -p "$(dirname "$PLIST")" "$ROOT/logs"
  # a hand-started relay holds the port; launchd's copy could never bind it
  local p; p="$(running_pid)"; [ -n "$p" ] && kill "$p" 2>/dev/null && rm -f "$PIDFILE" && sleep 1
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>-I</string>
    <string>$RELAY_DIR/cortex-mouth.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CORTEX_ROOT</key><string>$ROOT</string>
    <key>CORTEX_MOUTH_PORT</key><string>$PORT</string>
    <key>CORTEX_MOUTH_KEY</key><string></string>
    <key>PATH</key><string>$SVC_PATH</string>
  </dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$SVCLOG</string>
  <key>StandardErrorPath</key><string>$SVCLOG</string>
</dict>
</plist>
EOF
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  launchctl bootstrap "$DOMAIN" "$PLIST" && wait_health && green "relay installed; it now starts at every login"
}

relay_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  green "launchd agent removed; the relay no longer starts at login"
}

relay_status() {
  local h; h="$(health)"
  if [ -n "$h" ]; then green "  health:  $h"; else rose "  health:  no answer on 127.0.0.1:$PORT"; fi
  if under_launchd; then info "managed by: launchd ($LABEL)"
  elif [ -n "$(running_pid)" ]; then info "managed by: this CLI (pid $(running_pid)); not started at login"
  else info "managed by: nothing"; fi
  if [ -r "$TOKEN_FILE" ]; then info "token:   $TOKEN_FILE (present)"; else rose "  token:   missing ($TOKEN_FILE)"; fi
}

doctor() {
  local bad=0
  echo "cortex doctor"
  [ -r "$RELAY_DIR/cortex-mouth.py" ] && green "  ok  relay code in $RELAY_DIR" || { rose "  !!  relay code missing from $RELAY_DIR"; info "from a clone: bash scripts/mac-relay.sh setup"; bad=1; }
  if PATH="$SVC_PATH" command -v claude >/dev/null; then green "  ok  claude on the relay's PATH ($(PATH="$SVC_PATH" command -v claude))"
  else rose "  !!  claude is not on the relay's PATH"; info "install it with: npm install -g @anthropic-ai/claude-code"; bad=1; fi
  if [ -r "$TOKEN_FILE" ]; then green "  ok  subscription token at $TOKEN_FILE"
  else
    rose "  !!  no subscription token at $TOKEN_FILE"
    info "run 'claude setup-token' yourself, then save it with:"
    info "  umask 077; printf '%s' '<the-token>' > $TOKEN_FILE"
    info "then: cortex relay restart"
    bad=1
  fi
  health >/dev/null && green "  ok  relay live on 127.0.0.1:$PORT" || { rose "  !!  relay not answering on 127.0.0.1:$PORT"; info "start it: cortex relay start"; bad=1; }
  under_launchd && green "  ok  launchd starts the relay at login" || info "--  not started at login (optional): cortex relay install"
  return $bad
}

case "${1:-}" in
  setup) setup ;;
  relay)
    case "${2:-status}" in
      start)     relay_start ;;
      stop)      relay_stop ;;
      restart)   relay_restart ;;
      status)    relay_status ;;
      logs)      if [ "${3:-}" = "-f" ]; then tail -n 80 -f "$ROOT/logs/mouth-proxy.log"; else tail -n 80 "$ROOT/logs/mouth-proxy.log"; fi ;;
      install)   relay_install ;;
      uninstall) relay_uninstall ;;
      *) echo "usage: cortex relay start|stop|restart|status|logs [-f]|install|uninstall" >&2; exit 2 ;;
    esac ;;
  doctor) doctor ;;
  *) sed -n '2,21p' "$0" | sed 's/^#  \{0,1\}//'; exit 2 ;;
esac
