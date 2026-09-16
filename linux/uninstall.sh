#!/usr/bin/env bash
# ============================================================================
#  uninstall.sh — take it back off, without taking anything you might want.
#
#      bash linux/uninstall.sh
#
#  Stops and removes the two services and the cortex command. Leaves your vault
#  and your fleet tree exactly where they are, and tells you where, so removing
#  them is a decision you make on purpose rather than one this script makes for
#  you. Nothing here deletes a folder it did not create.
# ============================================================================
set -uo pipefail

BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
VAULT="${XDG_CONFIG_HOME:-$HOME/.config}/cortexinsight"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; GRN=$'\033[38;5;114m'; GLD=$'\033[38;5;179m'
else B=''; D=''; R=''; GRN=''; GLD=''; fi
ok()   { printf '  %s✓%s %s\n' "$GRN" "$R" "$*"; }
info() { printf '  %s%s%s\n' "$D" "$*" "$R"; }

printf '\n  %sRemoving CortexInsight from this machine%s\n\n' "$B" "$R"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  for u in cortexinsight.service cortex-relay.service; do
    systemctl --user stop "$u" >/dev/null 2>&1
    systemctl --user disable "$u" >/dev/null 2>&1
    [ -f "$UNIT_DIR/$u" ] && rm -f "$UNIT_DIR/$u" && ok "removed $u"
  done
  systemctl --user daemon-reload >/dev/null 2>&1
else
  # No service manager: stop it the way it was started.
  if [ -x "$BIN_DIR/cortex" ]; then "$BIN_DIR/cortex" stop >/dev/null 2>&1 && ok "stopped the console"; fi
fi

[ -f "$BIN_DIR/cortex" ] && rm -f "$BIN_DIR/cortex" && ok "removed the cortex command"

RUNTIME="${XDG_RUNTIME_DIR:-}"
[ -n "$RUNTIME" ] && rm -rf "$RUNTIME/cortexinsight" 2>/dev/null && ok "removed the socket"

printf '\n  %sLeft alone, on purpose:%s\n' "$B" "$R"
info "your vault        $VAULT"
info "                  (the board, the learnings, the focuses, and the sealed keys)"
info "your fleet tree   wherever you pointed it; the relay files are in its SystemsCortex folder"
info "your token        $HOME/.claude/cortex-oauth-token"
printf '\n  %sIf you mean to remove those too:%s\n' "$GLD" "$R"
info "rm -rf $VAULT"
printf '\n  Done.\n\n'
