# The documentation

Start here. Each page below is one door into the same house. Read them in the order you need, and come back to this map when you lose the thread.

## The map

```mermaid
flowchart LR
  R[README<br/>the front door] --> G[GUIDE<br/>the first hour, fourteen walkthroughs]
  R --> F[FEATURES<br/>what every room is for]
  G --> H[FIRST-HOUR<br/>a narrative of a new operator's day]
  F --> A[ARCHITECTURE<br/>processes, organs, data on disk]
  A --> C[CONTRIBUTING<br/>the laws, the ship gate]
  F --> I[INTEGRATIONS<br/>relay, OpenAI, voice, broadcast]
  R --> E[EVOLUTIONS<br/>six eras and their lessons]
  E --> U[FUTURE<br/>three horizons with falsifiers]
  R --> P[PITCH<br/>why this, why now, for whom]
  A --> L[GLOSSARY<br/>the words this console uses]
```

| Page | Read it when |
|---|---|
| [`PITCH.md`](PITCH.md) | You want to know whether this console is for you, in five minutes. |
| [`GUIDE.md`](GUIDE.md) | You have it running and want to do something real with it. |
| [`FIRST-HOUR.md`](FIRST-HOUR.md) | You want to see a whole first session, told as a story, before you start your own. |
| [`FEATURES.md`](FEATURES.md) | You want to know what a room is for, why it exists, and which module makes it work. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | You are about to change something and need to know where it lives. |
| [`GLOSSARY.md`](GLOSSARY.md) | A word in the app or the docs is new to you. |
| [`INTEGRATIONS.md`](INTEGRATIONS.md) | You are wiring a key, a relay, a voice, or the broadcast. |
| [`EVOLUTIONS.md`](EVOLUTIONS.md) | You want to know how it got this way, and what each version taught. |
| [`FUTURE.md`](FUTURE.md) | You want to know where it is going and how anyone would know it arrived. |
| [`MOTIVUS-ONE.md`](MOTIVUS-ONE.md) | You are the founder, or you want to know what the paid tier could hold. |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | You want to change it, or propose something. |
| [`../SECURITY.md`](../SECURITY.md), [`../OPEN-SOURCE.md`](../OPEN-SOURCE.md) | You want the threat model and the publishing gate. |

## The one loop every page is about

```mermaid
flowchart TB
  W[the fleet works<br/>transcripts, checkpoints, logs] --> R[readers<br/>read the growth, never the history]
  R --> I[instruments<br/>the reading, receipt quality, the seat clock,<br/>confidence, applied learnings]
  I --> A[actors<br/>the brief, loop prompts, the scheduler,<br/>seat choice, gates, pacing]
  A --> W
  O((the operator)) -. arms, ratifies, closes .-> A
  O -. reads .-> I
```

An instrument that only the operator reads is half built. Every reading in this console feeds at least one non-human decision, and the operator's attention goes to the decisions that cannot be delegated: what matters, what to arm, what to close.

## The direction of trust

```mermaid
flowchart LR
  AG[agents] -- append only --> Q[(the inbox queue)]
  Q -- validated, capped --> APP[the app]
  APP -- writes --> V[(the vault, sealed)]
  APP -- reads only --> T[(the fleet tree)]
  OP((operator)) -- the only hand on the switch --> MAX[Motus Max]
  APP -. one guarded block, backed up .-> RUN[the runner]
```

Agents append. The app applies. The operator arms. Nothing in the diagram runs the other way.

## In the app

Type `/help` on Command for the commands and these links. Press Ctrl+K and type `guide`. The About panel on Config links every page here.
