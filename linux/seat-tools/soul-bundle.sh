#!/usr/bin/env bash
# soul-bundle.sh — emit the COMPLETE prompt stack a seat reads, verbatim.
#   AUGUSTTT · the server · 2026-09-19
#
# Written because "show me your core prompt" must not be answered from memory.
# This reads every layer from its live source and concatenates them unedited.
# Re-run it any time; the output is the truth as of that second, not a snapshot.
#
#   soul-bundle.sh [agent] [out.md]      default: august -> workspace/SOUL-BUNDLE.md
set -uo pipefail

AGENT="${1:-august}"
OUT="${2:-/root/cortex/agents/august/workspace/SOUL-BUNDLE.md}"
ROOT=/root/cortex
RUNNER="$ROOT/SystemsCortex/cortex-run.sh"
SOUL="$ROOT/agents/$AGENT/SOUL.md"
CLAUDEMD="$ROOT/agents/$AGENT/workspace/CLAUDE.md"
MOTUSMIND="$ROOT/agents/$AGENT/workspace/MOTUSMIND.md"
MEMDIR="/root/.claude/projects/-root-cortex-agents-$AGENT-workspace/memory"
STATEDB="/root/.hermes/profiles/augusttt/state.db"
BRIEF="/root/.cortexinsight/brief.md"

die() { echo "soul-bundle: $*" >&2; exit 1; }
[ -r "$RUNNER" ] || die "no runner at $RUNNER"

# write to a temp and move only on success, so a failed run never leaves a
# half-written bundle where a complete one used to be.
TMP="$(mktemp -p "$(dirname "$OUT")")" || die "cannot create temp next to $OUT"
trap 'rm -f "$TMP"' EXIT

sect() { printf '\n\n---\n\n# %s\n\n_source: %s_\n\n' "$1" "$2" >> "$TMP"; }
# Reproduce a file inside a fence with ZERO added bytes, so the block can be
# extracted and diffed back against the original. An unconditional trailing
# newline here is what made the first bundle fail its own byte-identity check.
verb() {
  # CLAUDE.md and MOTUSMIND.md contain their own ``` fences. A three-backtick
  # wrapper would be closed by the first one inside and the rest of the file
  # would render as prose. So: find the longest backtick run in the file and
  # open with one longer — the CommonMark rule for nesting fenced blocks.
  local longest fence
  longest=$(grep -oE '^`+' "$1" 2>/dev/null | awk '{ if (length($0)>m) m=length($0) } END { print m+0 }')
  [ "$longest" -lt 3 ] && longest=3
  fence="$(printf '%*s' "$((longest+1))" '' | tr ' ' '`')"
  printf '%s\n' "$fence" >> "$TMP"; cat "$1" >> "$TMP"
  [ -n "$(tail -c1 "$1")" ] && printf '\n' >> "$TMP"   # only if it lacks a final LF
  printf '%s\n' "$fence" >> "$TMP"
}

{
  printf '# THE COMPLETE PROMPT STACK — seat `%s`\n\n' "$AGENT"
  printf '_Generated %s by `SystemsCortex/soul-bundle.sh`. Every layer is read from\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  printf 'its live source and reproduced verbatim — nothing here is summarised._\n\n'
  printf 'The layers arrive in this order on every turn:\n\n'
  printf '1. **Seat header** — hardcoded in `cortex-run.sh`\n'
  printf '2. **Mode block** — only when the gear is `motivus` or `max`\n'
  printf '3. **SOUL.md** — the identity file on disk\n'
  printf '4. **CLAUDE.md** — operations manual, auto-loaded from the seat cwd\n'
  printf '5. **Memory** — `MEMORY.md` + one file per durable fact\n'
  printf '6. **Hermes standing context** — a SECOND persona, stored in `state.db`\n'
  printf '7. **CortexInsight brief** — prepended to every message\n'
  printf '8. **MOTUSMIND.md** — read on demand, not auto-loaded\n'
} > "$TMP"

# --- integrity first: prove nothing has been edited -------------------------
sect "0 · INTEGRITY" "stat + sha256sum, run just now"
{
  printf '```\n'
  for f in "$SOUL" "$CLAUDEMD" "$MOTUSMIND"; do
    [ -r "$f" ] && stat -c '%-58s  %6s bytes   modified %y' "$f" "$f"
  done
  printf '\n'
  for f in "$SOUL" "$CLAUDEMD" "$MOTUSMIND"; do [ -r "$f" ] && sha256sum "$f"; done
  printf '```\n'
} >> "$TMP"

# --- 1. the seat header, pulled out of the runner itself --------------------
sect "1 · SEAT HEADER" "$RUNNER (hardcoded)"
{
  printf '```\n'
  sed -n '/SOUL_HINT="You are AUGUSTTT/,/^$/p' "$RUNNER" \
    | sed 's/^    SOUL_HINT="//; s/"$//'
  printf '```\n'
} >> "$TMP"

# --- 2. the deep-mode block -------------------------------------------------
sect "2 · MODE BLOCK (motivus / max only)" "$RUNNER (hardcoded)"
{
  printf '```\n'
  sed -n '/--- MODE: ${CORTEX_MODE^^}/,/do not trade it for speed."/p' "$RUNNER" | sed 's/"$//'
  printf '```\n'
} >> "$TMP"

# --- 3. SOUL.md, byte for byte ----------------------------------------------
sect "3 · SOUL.md — the identity" "$SOUL"
[ -r "$SOUL" ] && verb "$SOUL" || printf '_(missing)_\n' >> "$TMP"

# --- 4. CLAUDE.md -----------------------------------------------------------
sect "4 · CLAUDE.md — the operations manual" "$CLAUDEMD"
[ -r "$CLAUDEMD" ] && verb "$CLAUDEMD" || printf '_(missing)_\n' >> "$TMP"

# --- 5. memory --------------------------------------------------------------
sect "5 · MEMORY" "$MEMDIR"
if [ -d "$MEMDIR" ]; then
  # index first, then every other memory exactly once. The glob re-matches
  # MEMORY.md, so a seen-set is required — a name test alone lets it through.
  seen=""
  for f in "$MEMDIR"/MEMORY.md "$MEMDIR"/*.md; do
    [ -r "$f" ] || continue
    case " $seen " in *" $f "*) continue ;; esac
    seen="$seen $f"
    printf '\n## `%s`\n\n' "$(basename "$f")" >> "$TMP"; verb "$f"
  done
else printf '_(no memory dir)_\n' >> "$TMP"; fi

# --- 6. the Hermes standing context, out of the profile database ------------
# This is a SECOND, DIFFERENT persona from SOUL.md (sections I-VI, design-heavy)
# and it is prepended to the message body, not to the system prompt.
sect "6 · HERMES STANDING CONTEXT" "$STATEDB -> system_prompts (most recent persona row)"
if [ -r "$STATEDB" ] && command -v sqlite3 >/dev/null; then
  printf '```\n' >> "$TMP"
  sqlite3 "$STATEDB" \
    "select prompt from system_prompts where prompt like '%Symbolic & Structural Design%' limit 1" \
    2>/dev/null | sed -n '/^## I\. The Prime Stance/,/Semper Fortis\. Ad Infinitum\./p' >> "$TMP"
  printf '\n```\n' >> "$TMP"
else printf '_(sqlite3 or state.db unavailable)_\n' >> "$TMP"; fi

# --- 7. the brief -----------------------------------------------------------
sect "7 · CORTEXINSIGHT BRIEF (as of now)" "$BRIEF"
[ -r "$BRIEF" ] && verb "$BRIEF" || printf '_(no brief)_\n' >> "$TMP"

# --- 8. MOTUSMIND -----------------------------------------------------------
sect "8 · MOTUSMIND.md — the mindset (read on demand)" "$MOTUSMIND"
[ -r "$MOTUSMIND" ] && verb "$MOTUSMIND" || printf '_(missing)_\n' >> "$TMP"

mv "$TMP" "$OUT" || die "could not write $OUT"
chmod 644 "$OUT"
printf '%s\n' "$OUT"
wc -c < "$OUT" | xargs printf 'bytes: %s\n'
