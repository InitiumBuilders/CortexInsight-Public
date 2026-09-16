# CortexInsight on Linux

The same console, on a machine with no screen.

On Windows and macOS this app is a window. On a server it is a service with a
terminal in front of it and, when you want one, the window on your desktop
reaching it over SSH. It is the same program either way. Nothing here is a
cut-down version.

This page assumes you have never administered a Linux server before. Every step
says what it does and what you should see.

---

## What you end up with

- The console running as a service that starts again by itself after a reboot.
- The relay running beside it, so your agents answer on your own Claude
  subscription rather than a metered API key.
- A `cortex` command that talks to the fleet from any terminal.
- A vault paired to that machine, behind a passphrase you choose.
- An off switch that genuinely stops the machine spending anything.

---

## Before you start

You need three things.

1. **A Linux machine you can log into.** Ubuntu 22.04 or newer is what this is
   tested on. Any machine with systemd works. A small VPS is plenty: the console
   idles at well under 200 MB.
2. **A Claude subscription**, the same one you use at your desk.
3. **About ten minutes**, most of which is the sign-in step waiting for you.

You do not need Electron, a desktop, or an X server. The server install does not
download any of that.

---

## Installing

Log into the machine as your normal user. Not as root: the console runs as you,
and a vault owned by root would lock you out of your own console.

```bash
git clone https://github.com/InitiumBuilders/CortexInsight-Linux.git
cd CortexInsight-Linux
bash linux/install.sh
```

That is the whole thing. It is safe to run again later; every step checks
whether it is already done.

### What it will ask you

It asks before anything that needs administrator rights, and it shows you the
exact command first. If you say no, it tells you how to do that part yourself
and carries on.

| It asks | Say yes if |
|---|---|
| Install Node 22? | `node -v` shows nothing, or a version below 20 |
| Install the Claude Code CLI? | `claude` is not already on the machine |
| Run `claude setup-token`? | Yes. This is the sign-in, and it matters (below) |
| Use the fleet tree it found? | It found the folder your agents already use |
| Enable lingering? | Yes. Without it the console stops when you log out |

### The sign-in, and why it is a separate step

Signing in the ordinary way gives you credentials that expire in about a day. At
a desk you never notice. On a server it means the fleet goes quiet overnight and
nobody is awake to see it, and every turn fails with an authentication error
until you happen to look.

`claude setup-token` mints a token that lasts about a year. The installer saves
it to `~/.claude/cortex-oauth-token`, readable only by you, and every turn reads
it from there.

When it runs, it prints a link. Open the link, approve it, and paste back what
it gives you. That is the only part of the install that needs your hands.

### The last thing it does

It asks the fleet one short question and tells you whether an answer came back.
An install that reports success without ever asking the fleet a question has
proved the plumbing and nothing about whether the machine can actually speak.

---

## The first five minutes

```bash
cortex status
```

Nine lines telling you whether the machine is paired, the tree is readable, the
relay is up, and how many turns it can see.

```bash
cortex
```

The console opens and waits. Type a sentence and it goes to the fleet. Type
`help` for everything else. Press Ctrl-D or type `quit` to leave.

```bash
cortex doctor --live
```

Seven checks, each with the command that fixes it if it fails. `--live` spends
one short turn proving the fleet really answers.

---

## Living in the terminal

Anything you can see in the window, you can see here.

| | |
|---|---|
| `cortex` | open it and talk |
| `cortex "what moved today?"` | ask one thing without opening it |
| `cortex @davaris "…"` | ask one particular seat |
| `cortex status` | is everything up |
| `cortex pulse` | the reading, and the day drawn as a ring |
| `cortex board` | what is on the board |
| `cortex focus` | the Motus and the Goal, and what is drifting from them |
| `cortex agents` | the fleet, with the model and effort each seat is on |
| `cortex loops` | what Duo-Drive has armed |
| `cortex commands` | Davara's command library |
| `cortex protocols` | what she can invoke |
| `cortex live` | every event the console sees, as it happens |
| `cortex task "…"` | put something on the board |
| `cortex motus "…"` | name what everything is weighed against |

Inside the console, a line starting with `/` is handled by the fleet exactly as
it is in the window, so `/reading`, `/leverage` and the rest all work.

---

## Turning the agents off

This is the part worth reading twice, because the two settings do different
things.

```bash
cortex off
```

Stops everything **this console** drives: chat, the loops, workflows, auto-work.
A message sent to an agent from somewhere else, a messaging gateway or a cron,
still runs and still spends.

```bash
cortex off --hard
```

Writes the pause that **the runner itself** obeys. Every turn, from anywhere,
stops before the call. This is the only setting that guarantees nothing reaches
your subscription.

```bash
cortex on
```

Back on.

If you are leaving the machine running but not using it, `cortex off --hard` is
the honest way to stop it costing you anything.

---

## If that machine already runs a Hermes harness

It keeps working, and it goes through the same mouth.

The bundled relay is a drop-in: it listens on `127.0.0.1:8788`, speaks the
OpenAI chat-completions shape, streams when asked, and reads a seat out of the
model name. A gateway already pointed at that address needs no change at all.

Model names map to seats by the name inside them, longest first, so
`cortex-davara`, `davaris-fast`, `anything-workhorse` all land where you would
expect. Anything it does not recognise goes to the default seat, which you can
change with `CORTEX_DEFAULT_AGENT` in the relay's service file.

Two things to know if you had a relay there already:

- The installer noticed your fleet tree and asked before replacing the runner in
  it. If you said no, your runner is untouched and the console's fleet bridge is
  not in it, which means per-seat model choices and the hard stop will not reach
  your turns. `cortex doctor` says so.
- Only one thing can hold port 8788. If your own relay is already running there,
  either leave it and skip the bundled one (`systemctl --user disable --now
  cortex-relay`), or stop yours and let this one serve. They do the same job.

Either way, what an agent writes to the queue with `ci.sh` still lands on the
board, and the brief still rides at the top of every turn.

## Reaching it from your desktop

Open CortexInsight on your Windows or Mac machine and go to **Remote** in the
rail, at the bottom under CORE.

Fill in the host, your user, your SSH password, and the passphrase you chose
during the install. Press Connect.

The first time, it shows you the server's key fingerprint and waits. On the
server, this prints the same thing:

```bash
ssh-keyscan -t ed25519 localhost | ssh-keygen -lf -
```

If they match, press Trust this machine. From then on it checks that key every
time, and if it ever changes it stops and says so rather than connecting.

Once linked you get the server's reading, its board, its fleet, and a box to
talk to it. Turning its agents off from that page turns them off on the server.

---

## When something is wrong

```bash
cortex doctor          # seven checks, each with its fix
cortex logs            # what the console said
cortex relay status    # is the relay up and answering
cortex relay logs      # what the relay said
```

| You see | What it means | What to do |
|---|---|---|
| `CortexInsight is not running on this machine` | the service is not up | `cortex start`, then `cortex logs` |
| `a gate passphrase is set  ✗` | the vault has no passphrase yet | `cortex setup` |
| `the fleet tree is readable  ✗` | it cannot find your agents' folder | `cortex tree /path/to/it` |
| `the relay is up  ✗` | the relay is not answering | `cortex relay restart` |
| every turn says the machine is signed out | the token expired or was never saved | `claude setup-token`, save it to `~/.claude/cortex-oauth-token`, then `cortex relay restart` |
| the console stops when you log out | lingering is not enabled | `sudo loginctl enable-linger $USER` |

---

## Updating

```bash
cd CortexInsight-Linux
git pull
npm install --omit=dev
cortex restart
```

---

## Uninstalling

```bash
bash linux/uninstall.sh
```

It stops the services, removes them and the `cortex` command, and leaves your
vault and your fleet tree alone. It tells you where both are, so you can remove
them yourself if you mean to.

---

## Where things are

| | |
|---|---|
| the app | wherever you cloned it |
| the vault | `~/.config/cortexinsight/` (owner-only) |
| the seal key | `~/.config/cortexinsight/seal.key` (0600) |
| the relay and runner | `<your fleet tree>/SystemsCortex/` |
| the subscription token | `~/.claude/cortex-oauth-token` (0600) |
| the services | `~/.config/systemd/user/` |
| the socket | `$XDG_RUNTIME_DIR/cortexinsight/control.sock` (0600) |

---

## How it is put together, briefly

The engine room is `main.js`, the same file the window build runs. It does not
actually need a screen: it reads the fleet tree, talks to the relay, keeps the
board and runs the loops. What ties it to a desktop is that it asks Electron for
a window, a tray and a keyring.

`linux/electron-shim.js` gives it those, made of nothing, and runs the same
file. Not a port and not a second implementation that drifts. Every feature the
desktop app gains arrives here the day it is written, because it is the same
code answering.

What is genuinely absent is named rather than faked. There are no screen
instruments, because there is no screen; Motus Max drives in work mode, which is
files, commands and APIs, and it says so. There is no keyring either, so
`linux/seal.js` stands in its place: AES-256-GCM under a key derived from a
0600 key file, this machine's id, and your user id. A vault carried to another
machine is inert even if the key file travels with it.

The socket is the whole local attack surface, and it is deliberately small. It
is a Unix socket at mode 0600, never a TCP port, and a request can only ask for
a channel the app itself registered. Remote access rides SSH, which already has
an opinion about who you are.
