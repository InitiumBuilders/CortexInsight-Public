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
#    bash scripts/mac-relay.sh setup        the relay into ~/cortex/SystemsCortex,
#                                           this script to ~/cortex/bin/cortex
#  Then:
#    ~/cortex/bin/cortex relay start|stop|restart|status|logs [-f]
#    ~/cortex/bin/cortex relay install|uninstall   start at login via launchd, or stop that
#    ~/cortex/bin/cortex doctor                    what is missing, in order
#
#  Env, all optional: CORTEX_ROOT (default ~/cortex, or the folder above bin/
#  when run as the installed copy), CORTEX_MOUTH_PORT (8788), CORTEX_MOUTH_KEY
#  (passed through only when set), CORTEX_TOKEN_FILE (~/.claude/cortex-oauth-token),
#  CORTEX_LAUNCHD_LABEL (com.outlier.cortex-mouth-proxy).
# ============================================================================
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Run as <root>/bin/cortex, which is what setup installs, the fleet root is the
# folder above, so a tree set up somewhere other than ~/cortex finds itself.
if [ -z "${CORTEX_ROOT:-}" ] && [ "$(basename "$SELF_DIR")" = "bin" ] && [ -d "$SELF_DIR/../SystemsCortex" ]; then
  ROOT="$(cd "$SELF_DIR/.." && pwd)"
else
  ROOT="${CORTEX_ROOT:-$HOME/cortex}"
fi
# The same folder linux/install.sh fills and the console reads the runner from.
RELAY_DIR="$ROOT/SystemsCortex"
LEGACY_DIR="$ROOT/relay"              # where the first cut of this script put it
CLI="$ROOT/bin/cortex"
PORT="${CORTEX_MOUTH_PORT:-8788}"
PIDFILE="$ROOT/logs/relay.pid"
SVCLOG="$ROOT/logs/relay-service.log"
TOKEN_FILE="${CORTEX_TOKEN_FILE:-$HOME/.claude/cortex-oauth-token}"
LABEL="${CORTEX_LAUNCHD_LABEL:-com.outlier.cortex-mouth-proxy}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
# launchd starts with a bare PATH; claude usually lives in ~/.local/bin or Homebrew
SVC_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
RELAY_FILES="cortex-lib.sh cortex-mouth.py cortex-run.sh cortex-stream-parse.py hermes-tools-mcp.py motus-mode.sh relay-health.sh"

# Colour only for a person at a terminal: the console shows this output as text.
if [ -t 1 ]; then
  green() { printf '\033[32m%s\033[0m\n' "$*"; }
  rose()  { printf '\033[31m%s\033[0m\n' "$*"; }
else
  green() { printf '%s\n' "$*"; }
  rose()  { printf '%s\n' "$*"; }
fi
info()  { printf '  %s\n' "$*"; }

# The relay's capability key, decided the way the relay decides it: the variable
# when it is set (even empty), else ~/.cortex_mouth_key. A keyed relay answers
# only under /<key>/, so a health check without it would call a live relay dead.
mouth_key() {
  if [ -n "${CORTEX_MOUTH_KEY+set}" ]; then printf '%s' "$CORTEX_MOUTH_KEY" | tr -d '[:space:]'; return; fi
  [ -r "$HOME/.cortex_mouth_key" ] && tr -d '[:space:]' < "$HOME/.cortex_mouth_key"
}
# The URL goes in on stdin, so a key never shows in the process list.
health_body() {
  local k; k="$(mouth_key)"
  printf 'url = "http://127.0.0.1:%s/%shealth"\n' "$PORT" "${k:+$k/}" | curl -fsS -m 3 -K - 2>/dev/null
}
# Something answering on the port is not proof; the relay names itself.
health() {
  case "$(health_body)" in *claude-code-cli-relay*) return 0 ;; esac
  return 1
}

# The PID file is only a hint: after a crash or a reboot that number can belong
# to anything of the operator's. It is the relay only if its command line says
# so, and a file that points anywhere else is removed rather than trusted.
running_pid() {
  local p; p="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$p" ] || return 1
  if kill -0 "$p" 2>/dev/null && ps -p "$p" -o command= 2>/dev/null | grep -q 'cortex-mouth\.py'; then
    echo "$p"
    return 0
  fi
  rm -f "$PIDFILE"
  return 1
}

wait_gone() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.3
  done
  return 1
}

under_launchd() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

wait_health() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    health && return 0
    sleep 0.5
  done
  return 1
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# From a clone: the relay files into the tree, this script beside them as `cortex`.
# Re-running it is how a Mac takes a newer relay; a running relay is restarted onto it.
setup() {
  local src="$SELF_DIR/../linux/relay" f extra=""
  [ -r "$src/cortex-mouth.py" ] || { rose "no relay at $src; run setup from a clone of the repo"; return 1; }
  mkdir -p "$RELAY_DIR" "$ROOT/bin" "$ROOT/logs" "$ROOT/agents"
  cp -f "$src"/*.py "$src"/*.sh "$RELAY_DIR/"
  chmod 755 "$RELAY_DIR"/*.py "$RELAY_DIR"/*.sh
  # A launchd agent made by the first cut still starts $ROOT/relay/cortex-mouth.py,
  # so that folder becomes a link to the real one. Only a folder holding nothing
  # but relay files is replaced; anything else in it is the operator's.
  if [ -d "$LEGACY_DIR" ] && [ ! -L "$LEGACY_DIR" ] && [ -f "$LEGACY_DIR/cortex-mouth.py" ]; then
    for f in "$LEGACY_DIR"/* ; do
      case " $RELAY_FILES __pycache__ " in *" $(basename "$f") "*) ;; *) extra="$f" ;; esac
    done
    if [ -z "$extra" ]; then
      rm -rf "$LEGACY_DIR" && ln -s SystemsCortex "$LEGACY_DIR" \
        && info "the relay moved from $LEGACY_DIR to $RELAY_DIR; the old path links to it"
    else
      rose "$LEGACY_DIR holds files that are not the relay's ($extra); left as it is"
    fi
  fi
  cp -f "$SELF_DIR/mac-relay.sh" "$CLI"
  chmod 755 "$CLI"
  green "relay installed in $RELAY_DIR; the CLI is $CLI"
  if health; then relay_restart; else info "start it with: $CLI relay start"; fi
}

relay_start() {
  if health; then green "relay already live on 127.0.0.1:$PORT"; return 0; fi
  if under_launchd; then launchctl kickstart "$DOMAIN/$LABEL"
  else
    [ -r "$RELAY_DIR/cortex-mouth.py" ] || { rose "no relay in $RELAY_DIR; from a clone run: bash scripts/mac-relay.sh setup"; return 1; }
    mkdir -p "$ROOT/logs"
    # Owner-only files: the interaction logs hold every message and every reply.
    umask 077
    # PATH is pinned so a turn finds claude the same way the launchd agent does.
    # The key goes through only when it is set: an empty value would switch off
    # the relay's ~/.cortex_mouth_key fallback.
    nohup env CORTEX_ROOT="$ROOT" CORTEX_MOUTH_PORT="$PORT" PATH="$SVC_PATH" \
      ${CORTEX_MOUTH_KEY+CORTEX_MOUTH_KEY="$CORTEX_MOUTH_KEY"} \
      /usr/bin/python3 -I "$RELAY_DIR/cortex-mouth.py" >>"$SVCLOG" 2>&1 &
    echo $! > "$PIDFILE"
  fi
  if wait_health; then green "relay live on 127.0.0.1:$PORT"; return 0; fi
  running_pid >/dev/null || true          # a relay that died on start leaves no PID file
  rose "relay did not answer on 127.0.0.1:$PORT; see: $CLI relay logs"
  return 1
}

relay_stop() {
  if under_launchd; then
    # KeepAlive would bring it straight back; stopping for good is uninstall
    info "launchd keeps the relay alive; '$CLI relay uninstall' stops it for good"
    return 0
  fi
  local p; p="$(running_pid)"
  if [ -z "$p" ]; then info "no relay started by this CLI is running"; return 0; fi
  kill "$p" 2>/dev/null; rm -f "$PIDFILE"
  if wait_gone "$p"; then green "relay stopped"; else rose "relay (pid $p) did not stop within 3 seconds"; return 1; fi
}

relay_restart() {
  if under_launchd; then
    # A hand-started relay holding the port would answer for launchd's copy,
    # which could never bind; hand the port over before restarting the job.
    local h; h="$(running_pid)"
    if [ -n "$h" ]; then kill "$h" 2>/dev/null; rm -f "$PIDFILE"; wait_gone "$h"; fi
    launchctl kickstart -k "$DOMAIN/$LABEL" || { rose "launchd would not restart $LABEL"; return 1; }
    sleep 1
    if wait_health; then green "relay restarted on 127.0.0.1:$PORT"; return 0; fi
    rose "relay did not come back; see: $CLI relay logs"
    return 1
  fi
  local p; p="$(running_pid)"
  if [ -n "$p" ]; then kill "$p" 2>/dev/null; rm -f "$PIDFILE"; wait_gone "$p"; fi
  # Saying "restarted" about a relay nothing here stopped would be a lie.
  if health; then rose "a relay this CLI did not start answers on 127.0.0.1:$PORT, so it was not restarted"; return 1; fi
  relay_start
}

relay_install() {
  [ -r "$RELAY_DIR/cortex-mouth.py" ] || { rose "no relay in $RELAY_DIR; from a clone run: bash scripts/mac-relay.sh setup"; return 1; }
  mkdir -p "$(dirname "$PLIST")" "$ROOT/logs"
  # a hand-started relay holds the port; launchd's copy could never bind it
  local p; p="$(running_pid)"
  if [ -n "$p" ]; then kill "$p" 2>/dev/null; rm -f "$PIDFILE"; wait_gone "$p"; fi
  if health && ! under_launchd; then rose "a relay this CLI did not start answers on 127.0.0.1:$PORT; stop it first"; return 1; fi
  local key=""
  [ -n "${CORTEX_MOUTH_KEY+set}" ] && key="    <key>CORTEX_MOUTH_KEY</key><string>$(xml_escape "$CORTEX_MOUTH_KEY")</string>"
  # ProcessType Interactive: without it launchd throttles the job's CPU and I/O,
  # and every turn the relay runs inherits that. Umask 63 is 077: owner-only logs.
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>-I</string>
    <string>$(xml_escape "$RELAY_DIR/cortex-mouth.py")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CORTEX_ROOT</key><string>$(xml_escape "$ROOT")</string>
    <key>CORTEX_MOUTH_PORT</key><string>$(xml_escape "$PORT")</string>
    <key>PATH</key><string>$(xml_escape "$SVC_PATH")</string>
$key
  </dict>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$SVCLOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$SVCLOG")</string>
</dict>
</plist>
EOF
  # bootout returns before launchd has finished removing the old job, and a
  # bootstrap in that window fails with "5: Input/output error". Wait for the
  # job to be gone, and give the load a few tries.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  local i out="" loaded=""
  for i in 1 2 3 4 5 6 7 8 9 10; do under_launchd || break; sleep 0.5; done
  for i in 1 2 3 4 5; do
    if out="$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1)"; then loaded=1; break; fi
    sleep 1
  done
  if [ -z "$loaded" ]; then
    if under_launchd; then rose "launchd kept the job it had and would not load the new one: ${out:-no reason given}"; return 1; fi
    rose "launchd would not load $PLIST: ${out:-no reason given}"
    # The old job is gone, and the operator must never be left with no relay. The
    # job file goes too: left in place, the next login would start launchd's copy
    # beside this one, where it could never bind the port and would respawn
    # every few seconds. relay install puts it back.
    rm -f "$PLIST"
    info "starting the relay by hand for now; '$CLI relay install' hands it to launchd again"
    relay_start
    return 1
  fi
  if wait_health; then green "relay installed; launchd starts it at every login"; return 0; fi
  rose "launchd loaded the relay but it does not answer; see: $CLI relay logs"
  return 1
}

relay_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  green "launchd agent removed; the relay no longer starts at login"
}

relay_status() {
  local h; h="$(health_body)"
  if health; then green "  health:  $h"; else rose "  health:  no relay answers on 127.0.0.1:$PORT"; fi
  if under_launchd; then
    info "managed by: launchd ($LABEL)"
    [ -n "$(running_pid)" ] && rose "  but a hand-started relay (pid $(running_pid)) holds the port, so launchd's copy cannot bind; '$CLI relay restart' hands it over"
  elif [ -n "$(running_pid)" ]; then info "managed by: this CLI (pid $(running_pid)); not started at login"
  else info "managed by: nothing"; fi
  if [ -r "$TOKEN_FILE" ]; then info "token:   $TOKEN_FILE (present)"; else rose "  token:   missing ($TOKEN_FILE)"; fi
}

# The relay writes its turns to mouth-proxy.log; a relay that cannot even start
# (a taken port, a missing python) only ever speaks in the service log.
relay_logs() {
  if [ "${1:-}" = "-f" ]; then tail -n 40 -f "$ROOT/logs/mouth-proxy.log" "$SVCLOG"; return; fi
  echo "== $ROOT/logs/mouth-proxy.log"
  tail -n 60 "$ROOT/logs/mouth-proxy.log" 2>/dev/null
  echo "== $SVCLOG (start errors land here)"
  tail -n 20 "$SVCLOG" 2>/dev/null
}

doctor() {
  local bad=0
  echo "cortex doctor"
  [ -r "$RELAY_DIR/cortex-mouth.py" ] && green "  ok  relay code in $RELAY_DIR" || { rose "  !!  relay code missing from $RELAY_DIR"; info "from a clone: bash scripts/mac-relay.sh setup"; bad=1; }
  /usr/bin/python3 -c 1 2>/dev/null && green "  ok  /usr/bin/python3 runs" || { rose "  !!  /usr/bin/python3 does not run"; info "install the command line tools: xcode-select --install"; bad=1; }
  if PATH="$SVC_PATH" command -v claude >/dev/null; then green "  ok  claude on the relay's PATH ($(PATH="$SVC_PATH" command -v claude))"
  else rose "  !!  claude is not on the relay's PATH"; info "install it with: npm install -g @anthropic-ai/claude-code"; bad=1; fi
  if [ -r "$TOKEN_FILE" ]; then green "  ok  subscription token at $TOKEN_FILE"
  else
    rose "  !!  no subscription token at $TOKEN_FILE"
    info "run 'claude setup-token' yourself, then save it with:"
    info "  umask 077; printf '%s' '<the-token>' > $TOKEN_FILE"
    info "then: $CLI relay restart"
    bad=1
  fi
  health && green "  ok  relay live on 127.0.0.1:$PORT" || { rose "  !!  no relay answers on 127.0.0.1:$PORT"; info "start it: $CLI relay start"; bad=1; }
  if under_launchd; then
    green "  ok  launchd starts the relay at login"
    # setup restarts the relay onto new code, but launchd keeps the job definition
    # it loaded; only install rewrites that
    # Umask is the newest key the job carries; a plist without it predates it
    if grep -q "$LEGACY_DIR/" "$PLIST" 2>/dev/null || ! grep -q '<key>Umask</key>' "$PLIST" 2>/dev/null; then
      info "--  launchd runs an older job definition; '$CLI relay install' brings it up to date"
    fi
  else info "--  not started at login (optional): $CLI relay install"; fi
  return $bad
}

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

case "${1:-}" in
  setup) setup ;;
  relay)
    case "${2:-status}" in
      start)     relay_start ;;
      stop)      relay_stop ;;
      restart)   relay_restart ;;
      status)    relay_status ;;
      logs)      relay_logs "${3:-}" ;;
      install)   relay_install ;;
      uninstall) relay_uninstall ;;
      *) echo "usage: $CLI relay start|stop|restart|status|logs [-f]|install|uninstall" >&2; exit 2 ;;
    esac ;;
  doctor) doctor ;;
  *) usage; exit 2 ;;
esac
