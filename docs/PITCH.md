# The pitch

Five minutes on why this console exists, who it is for, and what it changes.

## The problem

You run a fleet of coding agents. They live in a terminal, in a shell you cannot see, on a subscription you cannot meter. You send a message and wait. A reply arrives with a claim: done, fixed, shipped. You take it on faith, because checking would take longer than the work did.

Every turn starts blind. The agent does not know what you are pushing on this week, what is open on your board, or what the last agent learned. You carry all of that in your head and type it again, or you do not, and the agent guesses.

The tools you have are a chat window and a log file. Neither closes a loop.

## What this console is

A room with instruments over the fleet you already run. It reads what the fleet already writes and never rewrites it. It shows the work as it happens. It hands every agent the same brief at the start of every turn. It keeps a board that moves, with a limit on what is open and a ritual for closing. It runs loops on a cadence, each one scored by a critic, and slows the loops that score badly. It can put an agent's hands on your keyboard when you arm it, and only then.

It runs on Windows, over a WSL fleet, on your own subscription and your own keys. Nothing phones home unless you turn a service on.

## What changes

**Turns start oriented.** The brief carries the reading of the whole system, your two focuses, the open board with short ids, and the strongest learnings. An agent answering from a phone gets the same brief as one answering in the console.

**Claims get receipts.** A loop pass must state a confidence with its basis and a falsifier with a clock, and walk one lived turn through its own change. A done claim is checked against the transcript. A pass without a receipt is reported, never shipped.

**The board closes itself.** The sweep names what is stale. The close proposes three decisions a day from what the ledger already knows. A finding that persists across two watchdog sweeps becomes a task that closes itself when the condition clears.

**Instruments feed actors.** The reading changes the prompts. Quality changes the cadence and the seat. Confidence changes the pacing and the gates. You read the gauges when you want to; the machine reads them every time.

**The hands are bounded.** Motus Max drives files, commands and APIs before it drives the screen. It refuses protected windows and credential-shaped text. It has a step budget, a time to live, a panic key, and an audit line per cycle.

## Who it is for

An operator who already runs agents through Claude Code and wants the loop between what they did and what they are told next to close without carrying the state by hand. A team of one, or a team of a few sharing a fleet. A builder who wants to see their agents' work rather than trust it.

It is not for someone who wants a hosted service. The free tree runs whole on your machine, and the paid tier, when it exists, adds services and never locks your data.

## What it costs

Attention, at first: setting the path, installing the bridge, teaching one agent the tool. After that, less attention than before. Tokens: fewer than you spend now, because idle passes cost nothing, the brief is capped, and the reflex router sends set-plan cycles to the leanest sound seat.

## Why open source

Because a console that can see everything the fleet does must itself be seen. The gate that scrubs the tree, the smoke that renders every view, the fresh test that walks a stranger's first hour, and the harness reports are all in the repository. Read them before you trust the exit code.

## The one line

An operator console that turns a chat window into a room with instruments, where every instrument feeds an actor and the operator's hand is the only thing that arms.

---

**Presented By Outlier.Systems**
**This Is A Service From Motivus.One**
