#!/usr/bin/env bash
# motus — is anything running on this box, and what is it costing?
#
# August, 2026-09-19: "tell me when you're moving or running in the background …
# and tell me when you're still or in idle, so I can easily turn you on or off."
#
# This is the READ side of that. The off switch itself lives in the CortexInsight
# console (Fleet → pause), which owns ~/.cortexinsight/fleet.json; nothing here
# writes to it. `restart-when-idle` is the one action, and it only ever acts on
# the relay, and only when no seat is mid-turn.
#
#   motus status              what is moving, what gear, what it has cost today
#   motus watch               status, refreshed every 3s
#   motus restart-when-idle   restart the relay the moment nothing is in flight
#
set -uo pipefail
ROOT=/root/cortex
CI="$HOME/.cortexinsight"
CG=/sys/fs/cgroup/user.slice/user-0.slice/user@0.service/app.slice/cortex-relay.service/cgroup.procs

dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

relay_pid() { systemctl --user show cortex-relay -p MainPID --value 2>/dev/null; }

# A seat is mid-turn when the relay's cgroup holds a process that is neither the
# relay itself nor this script's own ancestry.
#
# Counting the cgroup avoids `pgrep -f` matching its own command line. But it does
# NOT make this script invisible: run from a seat's own Bash tool, motus.sh IS
# inside cortex-relay.service's cgroup and was reporting itself as inflight —
# which meant `restart-when-idle`, called from inside a turn, could never see
# idle and would block the full hour. Found in review 2026-09-19. So walk up
# /proc/$$/stat and exclude this process and every parent of it.
self_tree() {
  local p=$$ n=0
  while [ "$p" -gt 1 ] && [ "$n" -lt 32 ]; do
    echo "$p"
    p="$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)" || break
    [ -n "$p" ] || break
    n=$(( n + 1 ))
  done
}

# $1 = "self" to also exclude this script's own ancestry. `status` must NOT pass
# it — a display that hides the turn you are asking from is a lying display.
# `restart-when-idle` MUST pass it, or it waits forever for itself to finish.
inflight_pids() {
  local relay mine; relay="$(relay_pid)"
  [ -r "$CG" ] || return 0
  mine="$([ "${1:-}" = "self" ] && self_tree)"
  awk -v r="${relay:-0}" 'NR==FNR{if($1!="")skip[$1]=1;next} $1!=r && !($1 in skip){print $1}' \
      <(printf '%s\n' "$mine") "$CG"
}

cmd_status() {
  local relay pids n
  relay="$(relay_pid)"; pids="$(inflight_pids)"; n="$(printf '%s' "$pids" | grep -c . || true)"

  bold "MOTUS — $(date -u '+%F %T') UTC"

  # ── state ───────────────────────────────────────────────────────────────────
  if [ "${n:-0}" -gt 0 ]; then
    local start age
    start="$(ps -o lstart= -p "$(printf '%s' "$pids" | head -1)" 2>/dev/null)"
    age="$(ps -o etime= -p "$(printf '%s' "$pids" | head -1)" 2>/dev/null | tr -d ' ')"
    echo "STATE     ● MOVING — $n process(es), oldest running ${age:-?}"
    printf '%s' "$pids" | while read -r p; do
      [ -n "$p" ] || continue
      # /proc/PID/cmdline is world-readable and carries whatever the caller put
      # on the line — a whole system prompt, or a bearer token in a -H argument.
      # Truncating to N bytes only works by luck about where the secret sits, so
      # do not truncate: take argv[0] and argv[1] ONLY, and scrub those two.
      # Review 2026-09-19 pulled a full secret out of a sibling process this way.
      printf '          %-8s %s\n' "$p" "$(
        tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null \
        | head -2 | tr '\n' ' ' \
        | sed -E 's#^[^ ]*/##; s#(sk[-_][A-Za-z0-9_-]{6})[A-Za-z0-9_-]*#\1…#g' \
        | head -c 56)"
    done
  else
    echo "STATE     ○ IDLE — nothing in flight, nothing being spent"
  fi

  # ── gear ────────────────────────────────────────────────────────────────────
  python3 - "$CI" <<'PY'
import json, os, sys, time
ci = sys.argv[1]
def load(p):
    try:
        with open(os.path.join(ci, p)) as f: return json.load(f)
    except Exception: return {}
fleet, modes = load("fleet.json"), load("modes.json")
a = (fleet.get("agents") or {}).get("august") or {}
m = modes.get("august") or {}
gear = f"{a.get('model','?')} · effort {a.get('effort','?')} · {a.get('turns','?')} turns"
def _epoch(v):
    """`until` is written as ISO-8601 Zulu by motus-mode.sh, but older records and
    hand edits carry an epoch number. Accept both, and never let a bad value take
    the whole status screen down with it — this block once crashed the entire
    report (GEAR, FLEET and all) whenever any deep mode was set, which is exactly
    when the operator most needs to read it."""
    if v in (None, "", 0):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        pass
    try:
        from datetime import datetime, timezone
        s = str(v).strip().replace("Z", "+00:00")
        d = datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.timestamp()
    except Exception:
        return None

if m.get("mode"):
    until = _epoch(m.get("until"))
    if until is None:
        gear += f"   [MODE {m['mode']}, no expiry]"
    else:
        left = int(until - time.time())
        gear += f"   [MODE {m['mode']}" + (f", {left//60} min left]" if left > 0 else ", expired]")
print(f"GEAR      {gear}")
live, off = [], []
for name, cfg in sorted((fleet.get("agents") or {}).items()):
    (off if cfg.get("paused") else live).append(name)
print(f"FLEET     live: {' '.join(live) or '(none)'}")
if off: print(f"          OFF:  {' '.join(off)}")
PY

  # ── services ────────────────────────────────────────────────────────────────
  local w t
  w="$(systemctl --user is-active safestep 2>/dev/null)"
  t="$(python3 -c "
import json,os
try: c=json.load(open(os.path.expanduser('~/.cortexinsight/safestep.json')))
except Exception: c={}
print('on' if (c.get('presence') or {}).get('typing', True) else 'off')" 2>/dev/null)"
  echo "RELAY     $(systemctl --user is-active cortex-relay 2>/dev/null) (pid ${relay:-?})"
  echo "WATCHER   ${w:-?} · typing indicator ${t:-?}"

  # ── what it has cost today ──────────────────────────────────────────────────
  python3 - "$ROOT" <<'PY'
import glob, json, os, sys, time
root = sys.argv[1]
day = time.strftime("%Y-%m-%d")
seats = {}
for f in glob.glob(os.path.join(root, "logs", "interactions", f"*-{day}.jsonl")):
    for line in open(f):
        line = line.strip()
        if not line: continue
        try: d = json.loads(line)
        except Exception: continue
        s = seats.setdefault(d.get("agent") or "?", [0, 0.0])
        s[0] += 1
        if isinstance(d.get("latency_s"), (int, float)): s[1] += d["latency_s"]
if seats:
    parts = [f"{k} {v[0]} ({v[1]/60:.0f}m)" for k, v in sorted(seats.items(), key=lambda kv: -kv[1][0])]
    print("TODAY     " + "   ".join(parts))
else:
    print("TODAY     no turns yet")
PY
  dim "OFF       the off switch is in the CortexInsight console: Fleet → pause."
  dim "          A paused seat never runs and nothing is spent. An IDLE seat"
  dim "          already spends nothing — there is no background burn to stop."
}

cmd_restart_when_idle() {
  local deadline=$(( $(date +%s) + 3600 )) quiet=0
  echo "waiting for the seat to go idle (up to 60 min)…"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -z "$(inflight_pids self)" ]; then
      quiet=$(( quiet + 1 ))
      # two consecutive quiet samples, so we never land inside the gap between
      # the relay accepting a request and the runner appearing in the cgroup
      if [ "$quiet" -ge 2 ]; then
        systemctl --user restart cortex-relay && echo "relay restarted at $(date -u '+%F %T')Z"
        return $?
      fi
    else
      quiet=0
    fi
    sleep 5
  done
  echo "still busy after 60 min — not restarting" >&2; return 1
}

case "${1:-status}" in
  status)            cmd_status ;;
  watch)             while :; do clear; cmd_status; sleep 3; done ;;
  restart-when-idle) cmd_restart_when_idle ;;
  *) echo "usage: motus [status|watch|restart-when-idle]" >&2; exit 2 ;;
esac
