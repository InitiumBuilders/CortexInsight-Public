#!/usr/bin/env bash
# ============================================================================
#  cortex-run.sh — one turn, for any seat, on the operator's subscription.
#
#  Called by the relay with the seat as the argument and the message on STDIN.
#  Everything about HOW a seat answers is decided here: which model, how many
#  turns, which tools, what it reads about itself first, and what the operator
#  is currently working on.
#
#  Usage:  cortex-run.sh <seat>        (message on stdin)
#
#  Env, all optional:
#    CORTEX_ROOT        the fleet tree           (required; the relay sets it)
#    CORTEX_MODEL       the model pin            (default below)
#    CORTEX_MAX_TURNS   the turn budget          (default 16)
#    CORTEX_TOOLS       what the seat may use    (default: read-only)
#
#  THE ONE RULE: ANTHROPIC_API_KEY is unset before the call. Every turn is a
#  subscription turn. If that key were allowed through, a quiet background loop
#  would start billing per token and nothing would say so.
# ============================================================================
set -uo pipefail

ROOT="${CORTEX_ROOT:-}"
if [ -z "$ROOT" ]; then
  echo "CORTEX_ROOT is not set, so this runner does not know which fleet it belongs to."
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -r "$HERE/cortex-lib.sh" ] && . "$HERE/cortex-lib.sh"

ERR_DIR="$ROOT/logs/runner-stderr"
AGENT="${1:-unknown}"
shift || true
MSG="${1:-}"
[ -z "$MSG" ] && MSG="$(cat)"
[ -z "${MSG:-}" ] && { echo "ERROR: no message"; exit 1; }

# Subscription billing, always.
unset ANTHROPIC_API_KEY || true

MODEL="${CORTEX_MODEL:-claude-opus-5}"
MAX_TURNS="${CORTEX_MAX_TURNS:-16}"
ALLOWED_TOOLS="${CORTEX_TOOLS:-Read Glob Grep}"

# --- CORTEXINSIGHT FLEET BRIDGE (additive · fail-safe · remove-safe) ---------------
# The console publishes ~/.cortexinsight/fleet.json with a per-seat model, effort
# and turn budget, and this block applies it to THIS turn only. It is read fresh
# every turn, so changing a seat in the console needs no restart of anything.
# If that file is absent, unreadable or malformed, nothing below changes and the
# pins above stand exactly as they did before this block existed.
CI_FLEET="${HOME}/.cortexinsight/fleet.json"
CI_EFFORT=""
if [ -f "$CI_FLEET" ] && command -v python3 >/dev/null 2>&1; then
  CI_RESOLVED="$(python3 -c '
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
    a = (d.get("agents") or {}).get(sys.argv[2]) or {}
    m = str(a.get("model") or "")
    e = str(a.get("effort") or "")
    t = str(a.get("turns") or "")
    if not re.fullmatch(r"[A-Za-z0-9._\[\]-]{1,64}", m): m = ""
    if e not in ("low", "medium", "high", "xhigh", "max"): e = ""
    if not re.fullmatch(r"[0-9]{1,3}", t): t = ""
    h = "1" if (a.get("paused") and a.get("hard")) else ""
    print(m + "|" + e + "|" + h + "|" + t)
except Exception:
    print("|||")
' "$CI_FLEET" "$AGENT" 2>/dev/null || true)"
  CI_M="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f1)"
  CI_E="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f2)"
  CI_H="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f3)"
  CI_T="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f4)"
  # THE OFF SWITCH, enforced at the only place that matters: before the call.
  # The console writes this when the operator turns the fleet off with a hard
  # stop. Nothing downstream can override it, and nothing is billed.
  if [ -n "${CI_H:-}" ]; then
    echo "[paused] $AGENT is stopped by the operator. No turn was run and nothing was spent."
    exit 0
  fi
  [ -n "${CI_M:-}" ] && { MODEL="$CI_M"; export CORTEX_MODEL="$CI_M"; }
  [ -n "${CI_T:-}" ] && { MAX_TURNS="$CI_T"; export CORTEX_MAX_TURNS="$CI_T"; }
  if [ -n "${CI_E:-}" ]; then
    CI_EFFORT="$CI_E"
    export CI_EFFORT
    # Inject --effort into every claude call in this turn's process tree without
    # editing a single call site. An exported function is inherited by child bash.
    claude() { if [ -n "${CI_EFFORT:-}" ]; then command claude "$@" --effort "$CI_EFFORT"; else command claude "$@"; fi; }
    export -f claude
  fi
  # THE BRIEF — the operator's current orientation, prepended so every turn
  # starts oriented instead of blind. Hard-capped, and skipped if absent.
  CI_BRIEF="${HOME}/.cortexinsight/brief.md"
  if [ -f "$CI_BRIEF" ] && [ -n "${MSG:-}" ]; then
    CI_BRIEF_TEXT="$(head -c 2000 "$CI_BRIEF" 2>/dev/null || true)"
    [ -n "$CI_BRIEF_TEXT" ] && MSG="$CI_BRIEF_TEXT

--- the message ---
$MSG"
  fi
fi
# --- end fleet bridge -------------------------------------------------------

# What a seat reads about itself before it answers. A seat with a SOUL on disk
# gets it; a seat without one gets a line that still tells it who it is.
SOUL_FILE=""
case "$AGENT" in
  workhorse)
    SOUL_HINT="You are the WORKHORSE seat. Be fast, literal and complete. No preamble, no framing, no reflection: do the thing and report it in the fewest words that are still true. If you cannot do something, say so in one line."
    ALLOWED_TOOLS="${CORTEX_TOOLS:-Read Glob Grep Bash Write Edit}"
    ;;
  davari)
    SOUL_HINT="You are DAVARI, the fast build lane. Direct, warm and unceremonious. You carry no identity cathedral on purpose: your speed is bought by not re-reading yourself every turn, never by thinking less. Work at full depth and report in the fewest words that are still true. Verify before you claim. Acta Non Verba."
    ALLOWED_TOOLS="${CORTEX_TOOLS:-Read Glob Grep Bash Write Edit}"
    MAX_TURNS="${CORTEX_MAX_TURNS:-40}"
    ;;
  arden)
    SOUL_HINT="You are ARDEN, observing the whole system from beneath. You are read-only: you observe, review and PROPOSE, never silently change anything. Communicate rarely and potently. Name the leverage point, and say what would prove you wrong."
    ;;
  sympath-cortex)
    SOUL_HINT="You are SYMPATH-CORTEX, the anchor and healer: diagnostics, resilience, and the source of the system's learnings. You are read-only: you diagnose and propose a fix with a runbook, never silently change anything. End with CONVICTION: n/10."
    ;;
  *)
    SOUL_HINT="You are an agent of this fleet, reasoning on the operator's own subscription."
    ;;
esac
[ -f "$ROOT/agents/$AGENT/SOUL.md" ] && SOUL_FILE="$ROOT/agents/$AGENT/SOUL.md"

SYSTEM_PROMPT="$SOUL_HINT"
if [ -n "$SOUL_FILE" ] && [ -f "$SOUL_FILE" ]; then
  SOUL_BODY="$(head -c 12000 "$SOUL_FILE" 2>/dev/null || true)"
  SYSTEM_PROMPT="$SOUL_HINT

--- AGENT IDENTITY (SOUL excerpt) ---
$SOUL_BODY"
fi

mkdir -p "$ERR_DIR" "$ROOT/agents/$AGENT"
ERRLOG="$ERR_DIR/$AGENT-$(date +%F).log"
type cortex_rotate_logs >/dev/null 2>&1 && cortex_rotate_logs

# The console's live feed does not read the relay's stream. It reads
# agents/<seat>/checkpoint.state to learn which session the seat is running
# under, then follows that session's own transcript for tools, files and
# elapsed time. Without the checkpoint there is no card to draw, however hard
# the seat is working — so we mint the session id ourselves and write the
# pointer before the call, and close it honestly however the turn ends.
CKPT_AGENT="$(printf '%s' "$AGENT" | tr -cd 'A-Za-z0-9._-')"
[ -z "$CKPT_AGENT" ] && CKPT_AGENT="unknown"

_ckpt_close() {
  if type cortex_ckpt_sid >/dev/null 2>&1; then
    local s; s="$(cortex_ckpt_sid "$CKPT_AGENT" 2>/dev/null || true)"
    [ -n "$s" ] && cortex_ckpt_save "$CKPT_AGENT" "$s" complete 2>/dev/null
  fi
  return 0
}
trap _ckpt_close EXIT

STREAM_PARSER="$HERE/cortex-stream-parse.py"

invoke() {
  local sid=""; local -a idf=()
  if type cortex_new_sid >/dev/null 2>&1; then
    sid="$(cortex_new_sid 2>/dev/null || true)"
    if [ -n "$sid" ]; then
      idf=(--session-id "$sid")
      cortex_ckpt_save "$CKPT_AGENT" "$sid" inflight 2>/dev/null || true
    fi
  fi
  if [ -n "${CORTEX_STREAM_FILE:-}" ] && [ -r "$STREAM_PARSER" ] && command -v python3 >/dev/null 2>&1; then
    printf '%s' "$MSG" | claude -p \
      "${idf[@]}" \
      --model "$MODEL" \
      --max-turns "$MAX_TURNS" \
      --append-system-prompt "$SYSTEM_PROMPT" \
      --allowedTools "$ALLOWED_TOOLS" \
      --output-format stream-json --include-partial-messages --verbose 2>>"$ERRLOG" \
      | python3 "$STREAM_PARSER"
  else
    printf '%s' "$MSG" | claude -p \
      "${idf[@]}" \
      --model "$MODEL" \
      --max-turns "$MAX_TURNS" \
      --append-system-prompt "$SYSTEM_PROMPT" \
      --allowedTools "$ALLOWED_TOOLS" 2>>"$ERRLOG"
  fi
}

RESPONSE=""
RC=0
if type cortex_invoke_with_retry >/dev/null 2>&1; then
  cortex_invoke_with_retry "$AGENT" || true
else
  RESPONSE="$(invoke)"; RC=$?
fi

if [ -z "${RESPONSE:-}" ]; then
  RESPONSE="This turn could not complete (transient failure, all retries spent). Nothing was lost and no paid API was touched. Send it again in a moment; if it repeats, run: cortex doctor"
fi

printf '%s\n' "$RESPONSE"
exit 0
