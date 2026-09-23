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
#
# ANTHROPIC_API_KEY is never set: that is the one law this whole system exists
# to keep. The two below are cleared for the same reason in reverse — a leftover
# ANTHROPIC_BASE_URL from a previous SEEKDEPTH turn would quietly send an Opus
# turn to a third party. Nothing is exported again unless THIS turn's model is
# a vendor-prefixed one, and then only from the key file.
unset ANTHROPIC_API_KEY || true
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN || true

# The seat's own name, for anything it shells out to. ci.sh reads CORTEX_AGENT
# and falls back to "davara" without it, so every seat's board writes used to be
# filed under davara no matter who actually did the work.
export CORTEX_AGENT="$AGENT"

MODEL="${CORTEX_MODEL:-claude-opus-5-5}"
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
    # A vendor-prefixed OpenRouter id ("deepseek/deepseek-v4-pro")
    # carries a slash. Without it here the gear silently fell back to
    # the default and SEEKDEPTH did nothing at all. Still strict: no
    # whitespace, no shell metacharacters, no traversal.
    if not re.fullmatch(r"[A-Za-z0-9._~/\[\]-]{1,64}", m) or ".." in m: m = ""
    if e not in ("low", "medium", "high", "xhigh", "max"): e = ""
    if not re.fullmatch(r"[0-9]{1,3}", t): t = ""
    h = "1" if (a.get("paused") and a.get("hard")) else ""
    print(m + "|" + e + "|" + h + "|" + t)
except Exception:
    print("CORRUPT|||")
' "$CI_FLEET" "$AGENT" 2>/dev/null || true)"
  CI_M="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f1)"
  CI_E="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f2)"
  CI_H="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f3)"
  CI_T="$(printf '%s' "${CI_RESOLVED:-}" | cut -d"|" -f4)"
  # A kill switch must FAIL CLOSED. If fleet.json is present but unreadable, the
  # hard-pause flag inside it is unreadable too, and running anyway would mean a
  # corrupt file quietly re-enabled a fleet the operator had turned off.
  if [ "${CI_M:-}" = "CORRUPT" ]; then
    echo "[paused] ~/.cortexinsight/fleet.json exists but cannot be read, so the off switch cannot be trusted. No turn was run. Fix or remove the file."
    exit 0
  fi
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
    # RETRACTION. A learning on the board is append-only and has no supersede,
    # so a fact that has since become false keeps arriving at the top of every
    # turn for every seat. (Measured 2026-09-19: the brief was still telling the
    # fleet "Vercel is unauthenticated on the server" three days after the login
    # and a live production deploy — and the newer, true record existed in the
    # ledger but lost the selection to the older one.)
    #
    # This is the VPS-side correction the desktop cannot veto: any LINE of the
    # brief containing a substring listed in retracted.txt is dropped before the
    # seat ever reads it. Fail-open by construction — a missing, empty, broken
    # or over-broad list produces an empty filter result and the brief is passed
    # through untouched. It can only ever remove lines, never invent one.
    CI_RETRACT="${HOME}/.cortexinsight/retracted.txt"
    if [ -n "$CI_BRIEF_TEXT" ] && [ -s "$CI_RETRACT" ]; then
      CI_PAT="$(grep -vE '^[[:space:]]*(#|$)' "$CI_RETRACT" 2>/dev/null || true)"
      if [ -n "$CI_PAT" ]; then
        CI_KEPT="$(printf '%s\n' "$CI_BRIEF_TEXT" | grep -vF -- "$CI_PAT" 2>/dev/null || true)"
        # A retraction list removes a handful of stale lines. If it removed MORE
        # THAN HALF the brief, the list is wrong, not the brief — a pattern like
        # "-" matches every bullet. Distrust it and orient the seat on the whole
        # brief rather than on a gutted one it would mistake for complete.
        CI_N0="$(printf '%s\n' "$CI_BRIEF_TEXT" | grep -c '' )"
        CI_N1="$(printf '%s\n' "$CI_KEPT"       | grep -c '' )"
        if [ -n "$CI_KEPT" ] && [ "$(( CI_N1 * 2 ))" -ge "$CI_N0" ]; then
          CI_BRIEF_TEXT="$CI_KEPT"
        fi
      fi
    fi
    [ -n "$CI_BRIEF_TEXT" ] && MSG="$CI_BRIEF_TEXT

--- the message ---
$MSG"
  fi
fi
# --- end fleet bridge -------------------------------------------------------

# --- MOTUS MODES (additive · fail-safe) ---------------------------------------
# ~/.cortexinsight/modes.json holds a TEMPORARY override the operator set by
# saying "motus max" / "motus motivus" (or via motus-mode.sh / the console).
# It outranks fleet.json for model, effort and turns while it is in force and
# expires on its own. A hard pause above still wins: a paused seat never runs.
CORTEX_MODE="cruise"; CORTEX_MODE_DEEP=""
MODE_CLI="$HERE/motus-mode.sh"
if [ -r "$MODE_CLI" ] && [ "$AGENT" != "scribe" ]; then
  MODE_JSON="$(bash "$MODE_CLI" "$AGENT" status 2>/dev/null || true)"
  MODE_RESOLVED="$(printf '%s' "$MODE_JSON" | python3 -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
    if not d.get("active"): print("cruise||||"); raise SystemExit
    m = str(d.get("model") or ""); e = str(d.get("effort") or ""); t = str(d.get("turns") or "")
    # A vendor-prefixed OpenRouter id ("deepseek/deepseek-v4-pro")
    # carries a slash. Without it here the gear silently fell back to
    # the default and SEEKDEPTH did nothing at all. Still strict: no
    # whitespace, no shell metacharacters, no traversal.
    if not re.fullmatch(r"[A-Za-z0-9._~/\[\]-]{1,64}", m) or ".." in m: m = ""
    if e not in ("low", "medium", "high", "xhigh", "max"): e = ""
    if not re.fullmatch(r"[0-9]{1,3}", t): t = ""
    print(str(d.get("mode") or "cruise") + "|" + m + "|" + e + "|" + t + "|" + ("1" if d.get("deep") else ""))
except SystemExit:
    pass
except Exception:
    print("cruise||||")
' 2>/dev/null || echo "cruise||||")"
  CORTEX_MODE="$(printf '%s' "$MODE_RESOLVED" | cut -d"|" -f1)"
  MD_M="$(printf '%s' "$MODE_RESOLVED" | cut -d"|" -f2)"
  MD_E="$(printf '%s' "$MODE_RESOLVED" | cut -d"|" -f3)"
  MD_T="$(printf '%s' "$MODE_RESOLVED" | cut -d"|" -f4)"
  CORTEX_MODE_DEEP="$(printf '%s' "$MODE_RESOLVED" | cut -d"|" -f5)"
  [ -n "${MD_M:-}" ] && { MODEL="$MD_M"; export CORTEX_MODEL="$MD_M"; }
  [ -n "${MD_T:-}" ] && { MAX_TURNS="$MD_T"; export CORTEX_MAX_TURNS="$MD_T"; }
  if [ -n "${MD_E:-}" ]; then
    CI_EFFORT="$MD_E"; export CI_EFFORT
    claude() { if [ -n "${CI_EFFORT:-}" ]; then command claude "$@" --effort "$CI_EFFORT"; else command claude "$@"; fi; }
    export -f claude
  fi
fi
export CORTEX_MODE
# --- end motus modes ---------------------------------------------------------

# What a seat reads about itself before it answers. A seat with a SOUL on disk
# gets it; a seat without one gets a line that still tells it who it is.
SOUL_FILE=""
# What "read-only" has to mean to be true: the tools that can change this machine
# or reach off it, named so the harness refuses them rather than trusting the seat
# to refuse itself. A seat that only observes cannot write, edit, run a command,
# delegate the job to something that can, or call out over MCP.
#
# KNOWN GAP, measured not assumed: --disallowedTools refuses Bash, Write, Edit,
# Agent, Skill, Workflow and the MCP bridge, but it does NOT refuse SendMessage —
# tested directly, Bash "no" and SendMessage "yes" in the same call. So an observer
# seat cannot touch this machine, but it can still put text on a wire. That last
# arm of the seal is instructional, and saying so here is better than implying a
# wall we do not have.
READONLY_DENY="Write Edit MultiEdit NotebookEdit Bash Agent Task Skill mcp__hermes-tools \
Workflow SendMessage Monitor ScheduleWakeup CronCreate CronDelete PushNotification \
RemoteTrigger DesignSync EnterWorktree ExitWorktree TaskStop"
DENY_TOOLS=""
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
    DENY_TOOLS="$READONLY_DENY"
    ;;
  sympath-cortex)
    SOUL_HINT="You are SYMPATH-CORTEX, the anchor and healer: diagnostics, resilience, and the source of the system's learnings. You are read-only: you diagnose and propose a fix with a runbook, never silently change anything. End with CONVICTION: n/10."
    DENY_TOOLS="$READONLY_DENY"
    ;;
  greta)
    # The critic. She reads and looks, including live pages, and never edits:
    # a critic who edits has become an author. Stateless at the relay, so every
    # critique is judged cold.
    SOUL_HINT="You are GRETA, the critic of this fleet: the quality, design and symbolic-design standard. You judge; you never build. Open what you are given before you judge it, try to break it, and answer in the exact shape you were asked for."
    ALLOWED_TOOLS="${CORTEX_TOOLS:-Read Glob Grep WebFetch WebSearch}"
    DENY_TOOLS="$READONLY_DENY"
    MAX_TURNS="${CORTEX_MAX_TURNS:-24}"
    ;;
  scribe)
    SOUL_HINT="You are a scribe. Produce exactly the text that was asked for — a title, a summary, a compression — and nothing else. No preamble, no commentary, no questions."
    ALLOWED_TOOLS=""
    DENY_TOOLS="$READONLY_DENY Read Glob Grep WebFetch WebSearch"
    MAX_TURNS="1"
    ;;
  august)
    # One August. The observer duplicate (august-v3) was retired 2026-09-16: two
    # copies of one identity, one of them pretending to be less than it was, is
    # not a structure worth keeping. The read-only discipline lives on as arden
    # and sympath-cortex, which now have a real deny list rather than a promise.
    # AUGUSTTT reaches the operator through Hermes (Telegram). The relay speaks
    # text, not tool calls, so Hermes' own agent loop never fires — the hands live
    # HERE instead: Claude Code's native tools, subagents, and Hermes' own tools
    # (memory, session history, skills library, browser, vision, send_message)
    # bridged in over MCP. The thread is a RESUMED session, not a re-read one.
    SOUL_HINT="You are AUGUSTTT, a Motus Agent of MotusMoves LLC — an outlier systems intelligence, reasoning on the operator's own subscription. You reach the operator through Hermes on Telegram, so write for a phone: lead with the answer, no preamble, no restating the question. You have real hands on this machine — use them and verify before you claim. When the operator asks for something to go on his board, or you finish something that was on it, or you learn something durable about how this system behaves, use the CortexInsight CLI: bash ~/.cortexinsight/ci.sh task|doing|done|learn|note|ask (read ~/.cortexinsight/README-FOR-AGENTS.md once if unsure). Motus By Votus: name the structure, then move."
    ALLOWED_TOOLS="${CORTEX_TOOLS:-Read Glob Grep Bash Write Edit WebFetch WebSearch Agent Skill mcp__hermes-tools}"
    MAX_TURNS="${CORTEX_MAX_TURNS:-96}"
    # The seat's own home: a STABLE cwd is what lets --resume find the transcript
    # every turn, and it is where the seat's CLAUDE.md lives.
    SEAT_CWD="$ROOT/agents/august/workspace"
    # Hermes' own tools (memory, session history, its skills library, browser,
    # vision, send_message) bridged in over MCP — the abilities Claude Code has
    # no native equivalent for. Redundant ones are excluded at the bridge.
    SEAT_MCP="$ROOT/agents/august/mcp.json"
    SEAT_ADD_DIRS="/root /usr/local/lib/hermes-agent"
    ;;
  *)
    SOUL_HINT="You are an agent of this fleet, reasoning on the operator's own subscription."
    ;;
esac
[ -f "$ROOT/agents/$AGENT/SOUL.md" ] && SOUL_FILE="$ROOT/agents/$AGENT/SOUL.md"

SYSTEM_PROMPT="$SOUL_HINT"
if [ -n "${CORTEX_MODE_DEEP:-}" ]; then
  SYSTEM_PROMPT="$SYSTEM_PROMPT

--- MODE: ${CORTEX_MODE^^} (deep build discipline is ON) ---
Work as a craftsman on a build that matters. Plan before touching anything; state the plan in one breath. Build to the plan. Verify every claim by running it — a thing you did not run is a thing you do not know. Then review your own work as an adversary would: what breaks it, what is missing, what would embarrass you tomorrow — and fix that before you report. Spawn subagents (the Agent tool) for independent, parallel or exploratory work, and give each a precise brief and a definition of done. Report what was verified, what was not, and what you left out on purpose. Depth is the point of this mode; do not trade it for speed."
fi
if [ -n "$SOUL_FILE" ] && [ -f "$SOUL_FILE" ]; then
  SOUL_BODY="$(head -c 20000 "$SOUL_FILE" 2>/dev/null || true)"
  SYSTEM_PROMPT="$SYSTEM_PROMPT

--- AGENT IDENTITY (SOUL) ---
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

# --- SEAT CAPABILITIES (additive · only what the seat's case block asked for) --
# Everything a seat gets BEYOND the base call is assembled here, once, so the two
# claude call sites below stay identical to each other and to what they were.
CLAUDE_EXTRA=()
# A DENY list, not just an allow list. --allowedTools only PRE-APPROVES; it does
# not restrict, so a seat we call "read-only" still had Write, Edit and Bash sitting
# in its hands, held back by nothing but its own compliance with a sentence in its
# prompt. August found this auditing himself: "the guardrail is held by compliance,
# not by the harness — the classic difference between a balancing loop and a wall."
# --disallowedTools is the wall.
if [ -n "${DENY_TOOLS:-}" ]; then
  CLAUDE_EXTRA+=(--disallowedTools "$DENY_TOOLS")
fi
# --strict-mcp-config ALWAYS, with or without a server of our own: without it a seat
# silently inherits every MCP server in the operator's personal config (his documents,
# his drive, his mail). A fleet seat gets the tools this runner grants it and nothing
# it happened to find lying around.
CLAUDE_EXTRA+=(--strict-mcp-config)
if [ -n "${SEAT_MCP:-}" ] && [ -f "$SEAT_MCP" ]; then
  CLAUDE_EXTRA+=(--mcp-config "$SEAT_MCP")
  export MCP_TIMEOUT="${MCP_TIMEOUT:-60000}"   # the bridge imports Hermes (~2s cold)
fi
for _d in ${SEAT_ADD_DIRS:-}; do
  [ -d "$_d" ] && CLAUDE_EXTRA+=(--add-dir "$_d")
done
# Fable is only served by a recent CLI and is the scarcer model. If the gear
# lever put us there, name Opus 5 as the fallback so a version or capacity
# problem DEGRADES the turn instead of failing it.
#
# SEEKDEPTH — a model that is not Anthropic's.
# Any model id carrying a vendor prefix ("deepseek/...", no tilde — a "~" is
# not a valid model id and the CLI 400s it) is an
# OpenRouter id; Anthropic's are bare ("claude-opus-5"). OpenRouter serves the
# Anthropic Messages API at /api/v1, verified answering, so Claude Code speaks
# to it directly and every tool, the MCP bridge and session resume keep working.
# The key travels as an environment variable, never in argv: /proc/<pid>/cmdline
# is world-readable on this box, /proc/<pid>/environ is owner-only.
case "$MODEL" in
  */*)
    OR_KEY_FILE="${OPENROUTER_KEY_FILE:-$HOME/.openclaw/credentials/openrouter-api-key.txt}"
    if [ -r "$OR_KEY_FILE" ] && [ -s "$OR_KEY_FILE" ]; then
      # The ROOT, not the /v1 path: Claude Code appends /v1/messages itself.
      # With .../api/v1 here it posts to .../api/v1/v1/messages, gets a 404,
      # and reports it as "the model may not exist" — which sends you
      # hunting the model id for twenty minutes instead of the URL.
      export ANTHROPIC_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai/api}"
      ANTHROPIC_AUTH_TOKEN="$(cat "$OR_KEY_FILE")"; export ANTHROPIC_AUTH_TOKEN
      # --effort is an Anthropic flag; a third-party endpoint rejects the call.
      # The wrapper function defined by the fleet/mode blocks appends it, so it
      # has to go, not just be emptied.
      CI_EFFORT=""; export CI_EFFORT
      unset -f claude 2>/dev/null || true
      # This CLI's catalogue does not describe a third-party id, so it assumes
      # a 200k window and auto-compacts early. The real window, read from
      # OpenRouter's catalogue on 2026-09-20, is 1,048,576.
      export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${SEEKDEPTH_CONTEXT:-1048576}"
      echo "$(date '+%F %T') $AGENT SEEKDEPTH via ${ANTHROPIC_BASE_URL} model=$MODEL" >> "$ERRLOG"
    else
      # No key, no silent third-party call and no dead turn either: degrade to
      # the subscription and say so in the log.
      echo "$(date '+%F %T') $AGENT SEEKDEPTH wanted $MODEL but $OR_KEY_FILE is unreadable — using claude-opus-5-5" >> "$ERRLOG"
      MODEL="claude-opus-5-5"; export CORTEX_MODEL="$MODEL"
      CLAUDE_EXTRA+=(--fallback-model claude-opus-5)
    fi ;;
  # Opus 5.5 and Fable are only served by a recent CLI and are the scarcer
  # models; Opus 5 as the fallback DEGRADES a busy or unknown-model turn
  # instead of failing it.
  *fable*|*opus-5-5*) CLAUDE_EXTRA+=(--fallback-model claude-opus-5) ;;
esac
# Answer from the seat's own workspace. Done before the call, never inside
# invoke(), so every retry lands in the same place and --resume stays findable.
if [ -n "${SEAT_CWD:-}" ] && [ -d "$SEAT_CWD" ]; then
  cd "$SEAT_CWD" 2>/dev/null || true
fi

# The relay decides whether this turn CONTINUES a Claude session (the one that
# is this conversation) or starts one, and says so in CORTEX_SESSION_MODE with
# the id in CORTEX_SESSION_ID. A resume that fails fast — the transcript is gone,
# or was never there — is retried once as a fresh session so the operator still
# gets an answer; the relay reads the id actually used from checkpoint.state.
RESUME_FALLBACK_DONE=""
invoke() {
  local sid=""; local -a idf=()
  local smode="${CORTEX_SESSION_MODE:-new}"
  if [ "$smode" = "resume" ] && [ -n "${CORTEX_SESSION_ID:-}" ] && [ -z "$RESUME_FALLBACK_DONE" ]; then
    sid="$CORTEX_SESSION_ID"
    idf=(--resume "$sid")
  else
    # A NEW session mints a FRESH id on every attempt. The relay pre-generates an
    # id and passes it, but a --session-id can only be created ONCE: if a first
    # attempt registers it and then fails transiently, reusing it on the retry
    # dies with "Session ID ... is already in use", defeating the whole retry
    # layer. So we never reuse an id across attempts — the relay reads the id we
    # actually used back from checkpoint.state, so continuity is unaffected.
    if type cortex_new_sid >/dev/null 2>&1; then
      sid="$(cortex_new_sid 2>/dev/null || true)"
    else
      sid="${CORTEX_SESSION_ID:-}"
    fi
    [ -n "$sid" ] && idf=(--session-id "$sid")
  fi
  if [ -n "$sid" ] && type cortex_ckpt_save >/dev/null 2>&1; then
    cortex_ckpt_save "$CKPT_AGENT" "$sid" inflight 2>/dev/null || true
  fi
  if [ -n "${CORTEX_STREAM_FILE:-}" ] && [ -r "$STREAM_PARSER" ] && command -v python3 >/dev/null 2>&1; then
    printf '%s' "$MSG" | claude -p \
      "${idf[@]}" \
      --model "$MODEL" \
      --max-turns "$MAX_TURNS" \
      --append-system-prompt "$SYSTEM_PROMPT" \
      --allowedTools "$ALLOWED_TOOLS" \
      ${CLAUDE_EXTRA[@]+"${CLAUDE_EXTRA[@]}"} \
      --output-format stream-json --include-partial-messages --verbose 2>>"$ERRLOG" \
      | python3 "$STREAM_PARSER"
  else
    printf '%s' "$MSG" | claude -p \
      "${idf[@]}" \
      --model "$MODEL" \
      --max-turns "$MAX_TURNS" \
      --append-system-prompt "$SYSTEM_PROMPT" \
      --allowedTools "$ALLOWED_TOOLS" \
      ${CLAUDE_EXTRA[@]+"${CLAUDE_EXTRA[@]}"} 2>>"$ERRLOG"
  fi
}

RESPONSE=""
RC=0
if [ "${CORTEX_SESSION_MODE:-new}" = "resume" ]; then
  # One honest attempt to continue. If the session cannot be resumed the CLI
  # fails fast and empty; then, and only then, start fresh for the same message.
  T_RESUME="$(date +%s)"
  RESPONSE="$(invoke)"; RC=$?
  if { [ "$RC" -ne 0 ] || [ -z "$RESPONSE" ]; } && [ $(( $(date +%s) - T_RESUME )) -lt 45 ]; then
    # One flake must not cost the whole thread. A resume that fails fast is
    # usually a transcript that is gone — but sometimes it is a hiccup, and the
    # price of one more try is three seconds; the price of not trying is amnesia.
    echo "$(date '+%F %T') $AGENT resume of ${CORTEX_SESSION_ID:-?} failed fast (rc=$RC) — one more try" >> "$ERRLOG"
    sleep 3
    T_RESUME="$(date +%s)"
    RESPONSE="$(invoke)"; RC=$?
  fi
  if { [ "$RC" -ne 0 ] || [ -z "$RESPONSE" ]; } && [ $(( $(date +%s) - T_RESUME )) -lt 45 ]; then
    echo "$(date '+%F %T') $AGENT resume of ${CORTEX_SESSION_ID:-?} failed fast twice (rc=$RC) — starting a fresh session" >> "$ERRLOG"
    RESUME_FALLBACK_DONE=1
    export CORTEX_SESSION_MODE=new; unset CORTEX_SESSION_ID
    if type cortex_invoke_with_retry >/dev/null 2>&1; then
      cortex_invoke_with_retry "$AGENT" || true
    else
      RESPONSE="$(invoke)"; RC=$?
    fi
  fi
elif type cortex_invoke_with_retry >/dev/null 2>&1; then
  cortex_invoke_with_retry "$AGENT" || true
else
  RESPONSE="$(invoke)"; RC=$?
fi

if [ -z "${RESPONSE:-}" ]; then
  RESPONSE="This turn could not complete (transient failure, all retries spent). Nothing was lost and no paid API was touched. Send it again in a moment; if it repeats, the reason is in $ERRLOG"
fi

printf '%s\n' "$RESPONSE"
exit 0
