#!/usr/bin/env bash
# ============================================================================
#  cortex-lib.sh — the parts every turn needs and none of them should own.
#
#  Sourced by cortex-run.sh. Sourcing it has exactly one intended side effect:
#  it exports the long-lived subscription token if one is on disk.
#
#  Env read at source time:
#    CORTEX_RETRY_MAX     retries after the first attempt   (default 2)
#    CORTEX_FLAKE_WINDOW  seconds; a failure faster than this is transient (45)
#    CORTEX_CKPT_TTL      how long an interrupted session may be resumed (1d)
#    CORTEX_TOKEN_FILE    where the subscription token lives
# ============================================================================

CORTEX_RETRY_MAX="${CORTEX_RETRY_MAX:-2}"
CORTEX_FLAKE_WINDOW="${CORTEX_FLAKE_WINDOW:-45}"
CORTEX_CKPT_TTL="${CORTEX_CKPT_TTL:-86400}"
CORTEX_TOKEN_FILE="${CORTEX_TOKEN_FILE:-$HOME/.claude/cortex-oauth-token}"

# ── Staying signed in on a machine nobody sits at ───────────────────────────
# An interactive Claude Code login writes credentials that expire in about a
# day. That is fine at a desk and useless on a server: the fleet goes silent
# overnight and the only symptom is turns failing with an auth error nobody is
# awake to read. `claude setup-token` mints a token that lasts about a year;
# the installer puts it here with mode 600, outside any repo, and every turn
# picks it up from this one place. An explicitly set token always wins.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r "$CORTEX_TOKEN_FILE" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$CORTEX_TOKEN_FILE")"
fi

cortex_new_sid() {
  uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null
}

cortex_ckpt_file() { echo "$ROOT/agents/$1/checkpoint.state"; }

# cortex_ckpt_save <seat> <session-id> <inflight|incomplete|complete>
# On disk, so it survives the invoke() subshell and a kill mid-turn.
cortex_ckpt_save() {
  mkdir -p "$ROOT/agents/$1" 2>/dev/null
  printf 'SID=%s\nSTATUS=%s\nEPOCH=%s\n' "$2" "$3" "$(date +%s)" > "$(cortex_ckpt_file "$1")"
}

cortex_ckpt_sid() {
  sed -n 's/^SID=//p' "$(cortex_ckpt_file "$1")" 2>/dev/null
}

# Echo a session id only if the last turn did NOT finish cleanly and is fresher
# than the TTL. A day-old interrupted thread must not hijack a fresh question.
cortex_ckpt_resume_sid() {
  local f sid status epoch now
  f="$(cortex_ckpt_file "$1")"
  [ -f "$f" ] || return 1
  sid="$(sed -n 's/^SID=//p' "$f")"
  status="$(sed -n 's/^STATUS=//p' "$f")"
  epoch="$(sed -n 's/^EPOCH=//p' "$f")"
  now="$(date +%s)"
  case "$status" in
    inflight|incomplete)
      [ -n "$sid" ] && [ $(( now - ${epoch:-0} )) -le "$CORTEX_CKPT_TTL" ] && { echo "$sid"; return 0; }
      ;;
  esac
  return 1
}

# The caller defines invoke() and sets ERRLOG. Sets RESPONSE and RC.
#
# A FAST failure is a flake and is retried with backoff. A SLOW failure is not:
# it is a real hang or a turn cap, and re-running it would stack the relay to
# three times the worst case while someone waits. That distinction is the whole
# policy, and it is why the window exists.
cortex_invoke_with_retry() {
  local label="${1:-relay}" attempt=0 t0 elapsed
  while :; do
    t0="$(date +%s)"
    RESPONSE="$(invoke)"; RC=$?
    elapsed=$(( $(date +%s) - t0 ))
    if [ "$RC" -eq 0 ] && [ -n "$RESPONSE" ]; then
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$CORTEX_RETRY_MAX" ] || [ "$elapsed" -ge "$CORTEX_FLAKE_WINDOW" ]; then
      echo "$(date '+%F %T') $label FINAL-FAIL rc=$RC after ${elapsed}s (attempts: $attempt)" >> "$ERRLOG"
      return 1
    fi
    echo "$(date '+%F %T') $label transient rc=$RC after ${elapsed}s — retry $attempt (backoff $((attempt * 3))s)" >> "$ERRLOG"
    sleep $((attempt * 3))
  done
}

# One generation of rotation for anything over 5 MB. Logs that grow without a
# ceiling are the quietest way to fill a small server's disk.
# Every subdirectory, not a named list: logs/safestep/watcher.log grew for days
# outside the two globs this used to carry, because nobody remembered to add it.
cortex_rotate_logs() {
  local f sz
  for f in "$ROOT"/logs/*.log "$ROOT"/logs/*/*.log; do
    [ -f "$f" ] || continue
    sz="$(stat -c %s "$f" 2>/dev/null || echo 0)"
    if [ "$sz" -gt 5242880 ]; then
      mv -f "$f" "$f.1" 2>/dev/null || true
    fi
  done
}
