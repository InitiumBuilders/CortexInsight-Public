#!/usr/bin/env bash
# ============================================================================
#  install.sh — CortexInsight on a Linux server, start to finish.
#
#  Run it as your normal user, NOT as root:
#
#      bash linux/install.sh
#
#  It is safe to run again. Every step checks whether it is already done and
#  says so instead of redoing it. Nothing is deleted, nothing is overwritten
#  without a backup beside it, and every command that needs administrator
#  rights asks first and tells you exactly what it is about to run.
#
#  When it finishes you will have:
#    · the console running as a service that comes back after a reboot
#    · the relay running beside it, on your own Claude subscription
#    · the `cortex` command on your PATH
#    · a vault paired to this machine, behind a passphrase you chose
# ============================================================================
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINUX_DIR="$APP_DIR/linux"
BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
TOKEN_FILE="$HOME/.claude/cortex-oauth-token"
STEP=0

# ── paint ───────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
  VIO=$'\033[38;5;141m'; GRN=$'\033[38;5;114m'; GLD=$'\033[38;5;179m'; ROSE=$'\033[38;5;204m'
else
  B=''; D=''; R=''; VIO=''; GRN=''; GLD=''; ROSE=''
fi
say()  { printf '%s\n' "$*"; }
step() { STEP=$((STEP + 1)); printf '\n%s[%d]%s %s%s%s\n' "$D" "$STEP" "$R" "$B" "$*" "$R"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '    %s!%s %s\n' "$GLD" "$R" "$*"; }
bad()  { printf '    %s✗%s %s\n' "$ROSE" "$R" "$*"; }
info() { printf '    %s%s%s\n' "$D" "$*" "$R"; }
die()  { printf '\n%s%s%s\n\n' "$ROSE" "$*" "$R"; exit 1; }

ask() {   # ask "question" [default y|n]  → 0 for yes
  local q="$1" def="${2:-y}" a
  # With nobody at the terminal, take the stated default. This used to answer
  # yes to everything, which quietly started an interactive sign-in that then
  # waited forever for a human who was never coming.
  if [ ! -t 0 ]; then [ "$def" = y ]; return; fi
  read -r -p "    $q [$( [ "$def" = y ] && echo 'Y/n' || echo 'y/N' )] " a </dev/tty || a=""
  a="${a:-$def}"
  [[ "$a" =~ ^[Yy] ]]
}

# Some steps cannot be done without a person: they open a browser, or ask for a
# passphrase. Skipping them cleanly is right; hanging on them is not.
interactive() { [ -t 0 ]; }

sudo_run() {  # show the command, ask, then run it
  info "this needs administrator rights:  sudo $*"
  # With nobody at the terminal, the answer is no. An installer that silently
  # escalates because it could not ask is an installer you cannot trust to run
  # from a script, and this one is meant to be re-runnable from anywhere.
  if [ ! -t 0 ]; then warn "skipped (nobody here to approve it)"; return 1; fi
  if ! ask "run it?" y; then warn "skipped"; return 1; fi
  sudo "$@"
}

say ""
say "  ${VIO}${B}CortexInsight${R} ${D}— installing on this machine${R}"
say "  ${D}$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") · $(uname -m) · $(whoami)@$(hostname)${R}"

[ "$(id -u)" = "0" ] && die "Run this as your normal user, not as root. The console runs as you, and a vault owned by root would lock you out of it."

# ── 1. the toolchain ────────────────────────────────────────────────────────
step "Checking what is already here"

have() { command -v "$1" >/dev/null 2>&1; }

if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then ok "Node $(node -v)"
  else
    warn "Node $(node -v) is too old; this needs 20 or newer"
    if ask "install Node 22 from NodeSource?" y; then
      curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh \
        && sudo_run bash /tmp/nodesource.sh && sudo_run apt-get install -y nodejs
    fi
    have node && ok "Node $(node -v)" || die "Node 20+ is required. Install it and run this again."
  fi
else
  warn "Node is not installed"
  if ask "install Node 22 from NodeSource?" y; then
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh \
      && sudo_run bash /tmp/nodesource.sh && sudo_run apt-get install -y nodejs
  fi
  have node || die "Node 20+ is required. Install it and run this again."
fi

have python3 && ok "Python $(python3 -V 2>&1 | cut -d' ' -f2)" || {
  warn "python3 is missing; the relay needs it"
  sudo_run apt-get install -y python3 || die "install python3 and run this again"
}
have git || warn "git is missing (only needed for updates)"
have curl || warn "curl is missing (only needed for health checks)"

# ── 2. Claude Code ──────────────────────────────────────────────────────────
step "Claude Code"
if have claude; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
else
  info "The relay runs every turn through the Claude Code CLI on your subscription."
  if ask "install it now with npm?" y; then
    npm install -g @anthropic-ai/claude-code 2>&1 | tail -3
  fi
  have claude || { warn "claude is still not on the PATH"; info "install it yourself with:  npm install -g @anthropic-ai/claude-code"; }
fi

# ── 3. signing in, so it stays signed in ────────────────────────────────────
step "Signing in"
if [ -r "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
  ok "a long-lived token is already saved"
  info "$TOKEN_FILE"
else
  say ""
  info "A normal login expires in about a day. On a server that means the fleet"
  info "goes quiet overnight and nobody is awake to notice. 'claude setup-token'"
  info "mints one that lasts about a year instead."
  say ""
  if ! interactive; then
    warn "signing in needs you at the keyboard — run this installer again from a terminal, or:"
    info "  claude setup-token   then save it to $TOKEN_FILE with mode 600"
  elif have claude && ask "run 'claude setup-token' now? (it opens a link for you to approve)" y; then
    mkdir -p "$HOME/.claude"; chmod 700 "$HOME/.claude" 2>/dev/null
    TOKEN="$(claude setup-token 2>/dev/null | tr -d '[:space:]' | grep -Eo '[A-Za-z0-9_.-]{40,}' | tail -1)"
    if [ -n "${TOKEN:-}" ]; then
      umask 077; printf '%s' "$TOKEN" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
      unset TOKEN
      ok "saved, readable only by you"
    else
      warn "no token came back"
      info "run 'claude setup-token' yourself, then save it with:"
      info "  umask 077; printf '%s' '<the-token>' > $TOKEN_FILE"
    fi
  else
    info "you can do this later; without it the relay uses whatever login claude already has"
  fi
fi

# ── 4. the fleet tree ───────────────────────────────────────────────────────
step "The fleet tree"
info "This is the folder the fleet keeps its logs, agents and memory in."
FOUND=""
for d in "$HOME"/*/; do
  [ -d "${d}logs/interactions" ] && [ -d "${d}agents" ] && FOUND="${d%/}" && break
done
if [ -n "$FOUND" ]; then
  ok "found one already: $FOUND"
  CORTEX_ROOT="$FOUND"
  if ! ask "use it?" y; then
    read -r -p "    path to use: " CORTEX_ROOT </dev/tty
  fi
else
  CORTEX_ROOT="${CORTEX_ROOT:-$HOME/cortex}"
  info "none found, so one will be created at $CORTEX_ROOT"
  if [ -t 0 ] && ask "use a different path?" n; then
    read -r -p "    path to use: " CORTEX_ROOT </dev/tty
  fi
fi
CORTEX_ROOT="${CORTEX_ROOT%/}"
mkdir -p "$CORTEX_ROOT"/{logs/interactions,logs/runner-stderr,agents,SystemsCortex}
chmod 700 "$CORTEX_ROOT" 2>/dev/null
ok "fleet tree: $CORTEX_ROOT"

# ── 5. the relay ────────────────────────────────────────────────────────────
step "The relay"
RELAY_DST="$CORTEX_ROOT/SystemsCortex"
for f in cortex-run.sh cortex-lib.sh cortex-mouth.py cortex-stream-parse.py; do
  SRC="$LINUX_DIR/relay/$f"
  DST="$RELAY_DST/$f"
  if [ -f "$DST" ] && ! cmp -s "$SRC" "$DST"; then
    # This tree may already be running a fleet. Replacing its runner without
    # asking would change how every agent on this machine answers.
    if [ -t 0 ] && ! ask "$f is already here and differs. Replace it? (a copy is kept)" y; then
      info "left your $f alone"
      continue
    fi
    if [ ! -t 0 ]; then
      warn "$f differs and nobody is here to approve replacing it — left alone"
      continue
    fi
    cp -p "$DST" "$DST.bak-$(date +%Y%m%d-%H%M%S)"
    info "your previous $f is beside it, with today's date"
  fi
  cp "$SRC" "$DST"
done
chmod +x "$RELAY_DST"/*.sh "$RELAY_DST"/*.py
bash -n "$RELAY_DST/cortex-run.sh" || die "the runner did not pass a syntax check; nothing was started"
# PYTHONDONTWRITEBYTECODE: the compile check used to leave a __pycache__ folder
# sitting in the operator's fleet tree, which this app treats as read-only
# territory by intent. Checking that something compiles should not write anything.
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile "$RELAY_DST/cortex-mouth.py" || die "the relay did not compile; nothing was started"
ok "installed and checked into $RELAY_DST"
ok "the console's fleet bridge is already in the runner"

# ── 6. the app ──────────────────────────────────────────────────────────────
step "The console"
cd "$APP_DIR" || die "cannot enter $APP_DIR"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok "dependencies already installed"
else
  info "one dependency, a few seconds — no Electron is downloaded for a server"
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2
fi
node --check main.js || die "main.js did not parse; refusing to install a broken build"
ok "the console parses"

# ── 7. the cortex command ───────────────────────────────────────────────────
step "The cortex command"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/cortex" <<EOF
#!/usr/bin/env bash
exec node "$LINUX_DIR/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/cortex"
ok "$BIN_DIR/cortex"
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "already on your PATH" ;;
  *)
    for rc in "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      grep -q 'HOME/.local/bin' "$rc" 2>/dev/null && continue
      printf '\n# added by CortexInsight\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
      ok "added it to your PATH in $(basename "$rc")"
      break
    done
    warn "open a new terminal, or run:  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# ── 8. services ─────────────────────────────────────────────────────────────
step "Keeping it running"
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  warn "there is no user service manager here (a container, most likely)"
  info "starting it directly instead"
  SERVICES=no
  export PATH="$BIN_DIR:$PATH"
  cortex start || true
else
  SERVICES=yes
  mkdir -p "$UNIT_DIR"
  NODE_BIN="$(command -v node)"
  PY_BIN="$(command -v python3)"

  cat > "$UNIT_DIR/cortex-relay.service" <<EOF
[Unit]
Description=Cortex relay (Claude Code, on the operator's subscription)
After=network.target

[Service]
Type=simple
Environment=HOME=$HOME
Environment=CORTEX_ROOT=$CORTEX_ROOT
Environment=CORTEX_MOUTH_PORT=8788
ExecStart=$PY_BIN $RELAY_DST/cortex-mouth.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

  cat > "$UNIT_DIR/cortexinsight.service" <<EOF
[Unit]
Description=CortexInsight (the operator console, headless)
After=cortex-relay.service
Wants=cortex-relay.service

[Service]
Type=simple
Environment=HOME=$HOME
Environment=CORTEX_HEADLESS=1
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $LINUX_DIR/host.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  ok "wrote two service files"

  # Without lingering, user services stop the moment you log out — which on a
  # server is most of the time, and is exactly when you want them running.
  if ! loginctl show-user "$(whoami)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    info "so the services keep running after you log out and after a reboot:"
    sudo_run loginctl enable-linger "$(whoami)" && ok "lingering enabled" || warn "not enabled — the services will stop when you log out"
  else
    ok "lingering already enabled"
  fi

  systemctl --user daemon-reload
  systemctl --user enable cortex-relay.service cortexinsight.service >/dev/null 2>&1
  systemctl --user restart cortex-relay.service
  sleep 2
  systemctl --user restart cortexinsight.service
  ok "both services enabled and started"
fi

# ── 9. the gate ─────────────────────────────────────────────────────────────
step "The gate"
export PATH="$BIN_DIR:$PATH"
for i in $(seq 1 60); do
  cortex status >/dev/null 2>&1 && break
  sleep 1
done
if ! cortex status >/dev/null 2>&1; then
  bad "the console did not answer"
  info "look at what it said:  cortex logs"
else
  ok "the console is answering"
  say ""
  info "This machine is now the one the vault belongs to. Choose a passphrase of"
  info "twelve characters or more. It is what the desktop app will ask for when"
  info "it connects to this server, and it is stored only as a hash."
  say ""
  if interactive; then
    cortex setup || true
  else
    warn "choosing a passphrase needs you at the keyboard — run:  cortex setup"
  fi
fi

# ── 10. what is true now ────────────────────────────────────────────────────
step "Checking everything"
# --live spends one short turn on purpose. An install that reports success
# without ever asking the fleet a question has proved the plumbing and nothing
# about whether this machine can actually speak.
if interactive; then cortex doctor --live || true; else cortex doctor || true; fi

say ""
if cortex status >/dev/null 2>&1; then
  say "  ${GRN}${B}Done — the console is up.${R}"
else
  say "  ${GLD}${B}Installed, but the console is not answering yet.${R}"
  say "  ${D}Run:  cortex logs    to see what it said, then:  cortex start${R}"
fi
say ""
say "  ${B}cortex${R}              ${D}open the console and talk to the fleet${R}"
say "  ${B}cortex status${R}       ${D}is everything up?${R}"
say "  ${B}cortex board${R}        ${D}what is on the board${R}"
say "  ${B}cortex off${R}          ${D}stop every agent (spends nothing)${R}"
say "  ${B}cortex off --hard${R}   ${D}and make the runner itself refuse turns${R}"
say "  ${B}cortex on${R}           ${D}back on${R}"
say "  ${B}cortex help${R}         ${D}everything else${R}"
say ""
[ "${SERVICES:-no}" = yes ] && say "  ${D}It will come back on its own after a reboot.${R}" || say "  ${D}Start it after a reboot with: cortex start${R}"
say ""
say "  ${D}To reach this machine from the desktop app, open Remote there and give it${R}"
say "  ${D}this host, your user, and the passphrase you just chose.${R}"
say ""
