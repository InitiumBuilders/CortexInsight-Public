# SafeStep — a clarity protocol for Motus agents

_The operator should never sit before a black screen that says "thinking."_
_Ground is gained in steps. A step worth taking is a step worth saying._

## The one law

**Speak only when something moved.** Not on a timer, not to fill silence, not to perform effort.
A signal is earned by ground gained, a door only the operator can open, a road worth naming,
a wall met honestly, or an arrival. Everything else is quiet — and the quiet is a promise:
*still moving, nothing you need to see yet.*

## The five signals

| mark | signal | when | what it carries |
|---|---|---|---|
| ◆ | **Ground** | a milestone is real — a file exists, a test passes, a deploy answers, a subagent returns | what now exists that did not before |
| ◇ | **Keystone** | a question only the operator can answer, and the work cannot honestly proceed without it | the question, the two live options, what happens if unanswered |
| → | **Next** | a move worth naming, seen from inside the work | one next move; at most two real alternatives |
| ⧗ | **Friction** | a wall met — a failure, a missing thing, a limit — and how it is being handled | the wall, the response, whether help is needed |
| ● | **Arrival** | the work is done, or has stopped | what moved, what was verified, what was left out on purpose, the one next move |

Five marks. No sixth. A message that fits none of them is not sent.

## Cadence

- **A quick answer needs no narrator.** SafeStep wakes only for work that is deep by gear
  (motivus / max) or has already run longer than a short reply should (90 s).
- **Floor: 90 s between Ground signals.** Events batch; the batch becomes one line. Keystone
  and Friction may break the floor (20 s) because waiting on them costs the operator time.
- **Ceiling: silence is bounded.** If the work is alive but nothing meaningful has moved for
  6 minutes, one honest line: *still moving · N tools · last: <what>* — then quiet again.
- **Arrival always lands**, even if nothing else did.

## Voice

Warm, direct, short. One to three lines. Movement verbs. The mark first, then the seat, then
the meaning. No "I am now going to." No apologies. No exclamation marks doing the work that
substance should. When the scribe writes the line it is asked for *the shape of what moved*,
not a diary of tool calls.

```
◆ august · The relay now heartbeats through silence. 35 pulses carried a 17-minute turn.
◇ august · Deploy to production, or preview first? Prod is one command; preview costs a minute and a look.
● august · SafeStepPreview is live at safesteppreview.vercel.app · 6 files · contrast 7.2:1 both modes · next: the desktop pull.
```

## Two sources, one voice

1. **The watcher** reads the seat's own live transcript. It needs nothing from the seat, cannot
   slow it, cannot break it, and sees every tool it uses. From raw events it derives Ground,
   Friction and Arrival, and a bounded "still moving."
2. **The seat itself** — through `safestep step|ask|next|friction|done "<line>"` — says what only
   it can know: the meaning of a milestone, a question for the operator, the next move. Explicit
   signals outrank derived ones and are never batched away.

The watcher makes SafeStep *reliable*. The seat makes it *meaningful*. Neither depends on the other.

## What SafeStep will never do

Narrate every tool call. Ask a question it could answer by reading. Send a line it would not
want to read at 2 a.m. Pretend a wall is a milestone. Speak for a seat that is not moving.

## Whose voice

Today SafeStep speaks through August's own bot, to the operator's DM (`transport: hermes`,
`hermes_profile: augusttt`, `chat: telegram` (the profile's home channel)). It is labelled — every line opens
with its mark in bold — so it is never mistaken for August answering.

When a bot of its own exists (a BotFather token), the switch is three lines and no code:

```bash
hermes profile create safestep --no-skills --no-alias --description "SafeStep — send-only"
printf 'TELEGRAM_BOT_TOKEN=<token>\nTELEGRAM_ALLOWED_USERS=<your chat id>\nTELEGRAM_HOME_CHANNEL=<your chat id>\n' \
  > /root/.hermes/profiles/safestep/.env && chmod 600 /root/.hermes/profiles/safestep/.env
# then in ~/.cortexinsight/safestep.json:  "hermes_profile": "safestep"
```

Never start a gateway for that profile — `hermes send` needs none, and a gateway would
long-poll the bot. To speak in the DAVARA EI TEAM group instead (`-1003919861911`), add the
new bot to the group and set `"chat": "telegram:-<group id>:<topic>"`. Do not borrow
Davara's bot for it: a voice that sounds like someone else is the one thing this protocol
must never be.

## Where it lives

- `~/.cortexinsight/safestep.json` — who to tell (a Telegram chat), through which voice (a bot
  token, or the seat's own), cadence knobs.
- `/root/cortex/safestep/` — the watcher, the CLI, its unit.
- `<fleet>/agents/<seat>/safestep.jsonl` — the seat's explicit signals, one JSON line each.
- The signals themselves are also written to `<fleet>/logs/safestep/<seat>-<date>.jsonl` so the
  console can draw them and the operator can read the day as steps.

`{{{` Ground · Keystone · Next · Friction · Arrival. Five marks. Speak when it moves.
