#!/usr/bin/env bash
# gate.sh — GATES BEFORE GLASS.
#   AUGUSTTT · the server · 2026-09-19
#
# Why this exists
# ---------------
# SOUL.md §III says: "never exhort a system to behave against its own
# architecture." SOUL.md is then almost entirely exhortation. Three sessions
# running, a law in that file was violated in the same session it was quoted:
#   · "never certify your own build"  -> certified it; a reviewer found worse.
#   · "verify by running it"          -> ran a suite that could not fail.
#   · "the key never appears in argv" -> written in a header while it did.
# A law with no instrument is a mood. This is the instrument.
#
# The rule it enforces is the one variable that separated the two builds of
# this week: SafeStep had seven gates written BEFORE the page existed and
# shipped in one pass; motus-voice was written first and took three.
# So: declare the conditions that would prove it wrong, then build.
#
# Usage
#   gate.sh init <name>                   scaffold a gates file
#   gate.sh run  <gatesfile> [--record]   run every gate; nonzero if any fail
#   gate.sh last <name>                   show the most recent record
#
# A gates file is bash. It calls gate "<what must be true>" '<shell command>'.
# A gate PASSES when its command exits 0. Nothing else counts — not a comment,
# not an intention, not a green log line.
set -uo pipefail

REC_DIR="${GATE_REC_DIR:-/root/cortex/SystemsCortex/.gates}"
die() { echo "gate: $*" >&2; exit 1; }

GATE_TOTAL=0; GATE_FAILED=0; GATE_LOG=""

# Called from inside a gates file.
gate() {
  local what="${1:-}" cmd="${2:-}"
  [ -n "$what" ] && [ -n "$cmd" ] || die "gate needs a name and a command"
  GATE_TOTAL=$((GATE_TOTAL+1))
  local out rc
  out="$(eval "$cmd" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    printf '  \033[32mPASS\033[0m  %s\n' "$what"
    GATE_LOG="${GATE_LOG}PASS|${what}|${rc}"$'\n'
  else
    GATE_FAILED=$((GATE_FAILED+1))
    printf '  \033[31mFAIL\033[0m  %s  (exit %s)\n' "$what" "$rc"
    printf '%s\n' "$out" | head -8 | sed 's/^/        /'
    GATE_LOG="${GATE_LOG}FAIL|${what}|${rc}"$'\n'
  fi
  return 0        # never abort the run: every gate must be reported, not just the first
}

cmd_init() {
  local name="${1:-}"; [ -n "$name" ] || die 'usage: gate.sh init <name>'
  local f="gates.$name"
  [ -e "$f" ] && die "$f already exists — refusing to overwrite"
  cat > "$f" <<'EOF'
# Gates. Written BEFORE the thing they judge.
# Each line: gate "<what must be true>" '<command that exits 0 when it is>'
#
# Ask, in this order:
#   1. What would prove this wrong?
#   2. What would embarrass me tomorrow?
#   3. What must NEVER happen, even once?
# Then write the gate that catches it, and only then build.

gate "it does the thing at all"        'false   # replace me'
EOF
  chmod 644 "$f"; printf '%s\n' "$f"
}

cmd_run() {
  local f="${1:-}" record=0
  [ -n "$f" ] || die 'usage: gate.sh run <gatesfile> [--record]'
  [ -r "$f" ] || die "no such gates file: $f"
  [ "${2:-}" = "--record" ] && record=1
  printf '\ngates: %s\n\n' "$f"
  # shellcheck disable=SC1090
  . "$f"
  [ "$GATE_TOTAL" -gt 0 ] || die "$f declared no gates — an empty gate file is not a pass"
  printf '\n  %s/%s passed\n\n' "$((GATE_TOTAL-GATE_FAILED))" "$GATE_TOTAL"
  if [ "$record" = 1 ]; then
    mkdir -p "$REC_DIR" || die "cannot create $REC_DIR"
    local base rec
    base="$(basename "$f" | sed 's/^gates\.//')"
    rec="$REC_DIR/$base-$(date -u +%Y%m%dT%H%M%SZ).txt"
    { printf 'gates-file: %s\nwhen: %s\nhost: %s\npassed: %s/%s\n\n' \
        "$(readlink -f "$f")" "$(date -u '+%Y-%m-%d %H:%M:%SZ')" "$(hostname)" \
        "$((GATE_TOTAL-GATE_FAILED))" "$GATE_TOTAL"
      printf '%s' "$GATE_LOG"; } > "$rec"
    chmod 644 "$rec"; printf 'record: %s\n' "$rec"
  fi
  [ "$GATE_FAILED" -eq 0 ]
}

cmd_last() {
  local name="${1:-}"; [ -n "$name" ] || die 'usage: gate.sh last <name>'
  local f; f="$(ls -1t "$REC_DIR/$name"-*.txt 2>/dev/null | head -1)"
  [ -n "$f" ] || die "no record for '$name' — it has never passed a gate run"
  cat "$f"
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  run)  shift; cmd_run  "$@" ;;
  last) shift; cmd_last "$@" ;;
  ""|-h|--help|help) sed -n '23,30p' "$0" | sed 's/^# \?//' ;;
  *) die "unknown command: $1" ;;
esac
