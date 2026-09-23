#!/usr/bin/env bash
# ============================================================================
#  safestep.sh — the seat's own voice in SafeStep.
#
#  The watcher can see every tool a seat uses; it cannot see what a milestone
#  MEANS, or that a question has arisen that only the operator can answer. This
#  is how the seat says so, in one line, from inside the work:
#
#    safestep.sh step     "<what now exists that did not before>"      ◆ Ground
#    safestep.sh ask      "<question · option A · option B>"           ◇ Keystone
#    safestep.sh next     "<the one move worth naming>"                → Next
#    safestep.sh friction "<the wall · how it is being handled>"       ⧗ Friction
#    safestep.sh done     "<what moved · next move>"                   ● Arrival
#
#  Each call appends one JSON line to <fleet>/agents/<seat>/safestep.jsonl. The
#  watcher forwards it immediately — explicit signals outrank derived ones and are
#  never batched away. If the watcher is not running, the line simply waits; it
#  is always safe to call. Speak only when something moved.
#
#  Env (all optional): CORTEX_ROOT (fleet tree), CORTEX_AGENT (the seat).
# ============================================================================
set -uo pipefail
ROOT="${CORTEX_ROOT:-/root/cortex}"
SEAT="${CORTEX_AGENT:-${CI_AGENT:-august}}"
KIND="${1:-}"; TEXT="${2:-}"
case "$KIND" in
  step|ask|next|friction|done) ;;
  *) echo "usage: safestep.sh step|ask|next|friction|done \"<one line>\"" >&2; exit 2 ;;
esac
if [ -z "$TEXT" ]; then
  echo "safestep: a signal needs a line — what moved?" >&2; exit 2
fi
SEAT="$(printf '%s' "$SEAT" | tr -cd 'A-Za-z0-9._-')"
mkdir -p "$ROOT/agents/$SEAT"
python3 - "$KIND" "$TEXT" "$SEAT" >> "$ROOT/agents/$SEAT/safestep.jsonl" <<'PY'
import json, sys, time
kind, text, seat = sys.argv[1:4]
print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "seat": seat, "kind": kind,
                  "text": " ".join(text.split())[:600]}, ensure_ascii=False))
PY
echo "safestep: ${KIND} signaled"
