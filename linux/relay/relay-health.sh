#!/usr/bin/env bash
# relay-health.sh — the check that Restart=always cannot make.
#
# systemd restarts a process that DIES. It has nothing to say about one that is
# alive and wedged: a hung accept loop, an exhausted thread pool, a socket that
# answers TCP and then nothing. That failure is silent and it is the one that
# strands the operator mid-conversation, because Hermes just waits.
#
# So: ask the relay to speak. Two strikes, because a single slow answer under a
# long turn is not an outage and restarting on it would kill live work.
set -uo pipefail
PORT="${CORTEX_MOUTH_PORT:-8788}"
URL="http://127.0.0.1:${PORT}/health"
LOG="${CORTEX_ROOT:-/root/cortex}/logs/relay-health.log"
mkdir -p "$(dirname "$LOG")"

probe() { curl -fsS -m 8 "$URL" 2>/dev/null | grep -q '"status": "ok"'; }

if probe; then exit 0; fi
sleep 5
if probe; then
  echo "$(date '+%F %T') slow but alive (first probe missed, second answered)" >> "$LOG"
  exit 0
fi

echo "$(date '+%F %T') UNRESPONSIVE on $URL after two probes — restarting cortex-relay" >> "$LOG"
systemctl --user restart cortex-relay.service
sleep 5
if probe; then
  echo "$(date '+%F %T') recovered after restart" >> "$LOG"
else
  echo "$(date '+%F %T') STILL DOWN after restart — needs a human" >> "$LOG"
fi
