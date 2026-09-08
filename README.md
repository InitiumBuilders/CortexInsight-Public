# CortexInsight

A desktop operator console for a fleet of coding agents that live on your own machine.

It reads what the fleet already writes (transcripts, checkpoints, logs) and shows the work as it happens. It hands every agent a shared brief at the start of each turn. It keeps a board that moves, runs loops and workflows with a critic on every pass, and can put an agent's hands on the keyboard when you arm it. Every key is sealed on the machine. Nothing phones home unless you turn a service on.

**Presented By Outlier.Systems**
**This Is A Service From Motivus.One**

Source: https://github.com/InitiumBuilders/Semble-CC · Live surface: https://semble.cc/live

---

## Why it exists

An agent fleet that runs through a terminal is a black box with a chat window. You send a message, something happens in a shell you cannot see, and a reply arrives later with a claim attached. Every turn starts blind, every "done" is taken on faith, and the operator carries the whole state in their head.

CortexInsight turns the box into a room with instruments. The fleet's own files are the source of truth, read live and never rewritten. The board, the loops and the readings all feed back into what the agents are told next. A claim of "done" gets checked against the transcript. A pass gets a score. A drive starts on a read the agent already made. The operator's attention goes to judgement, and the console holds everything else.

## The promises the code keeps

- **Read-only on the fleet.** The console reads logs, checkpoints, transcripts and memory. It writes its own vault, its own sidecars, and one small guarded block in the runner when you install the bridge. The two explicit levers (model pin, turn budget) are confirmed and backed up.
- **Agents append, the app applies.** An agent can only add a line to a queue. The app validates and applies each line under caps you set. Nothing an agent writes can spend without your cap.
- **The operator arms.** Motus Max cannot be armed by an agent, by a command, or by a spoken word. Your hand on the switch is the only door. A panic key halts it.
- **Sealed by default.** Provider keys are verified against their provider, then sealed with the OS keystore. The renderer never sees a key. A copied vault is inert on another machine.
- **Receipts over claims.** Loops and workflow stages must report a confidence with its basis and a falsifier with a clock. Low quality slows a loop down. A gate that passes at low confidence is a block.
- **Off means absent.** When the broadcast is off, the payload carries nothing. When a key is cleared, the ciphertext is deleted. When a task is parked, it is never scheduled.

## Get the app

**Download.** Every version tag is built on runners none of the authors have touched, one Windows and one Mac, and the zips land on the [Releases page](https://github.com/InitiumBuilders/Semble-CC/releases). Windows: unzip, run `CortexInsight.exe`. Mac: unzip the arm64 zip on Apple silicon or the x64 zip on Intel, right-click the app, Open. Neither build is code-signed yet, so each platform asks once.

**Or build it yourself, one command.** Windows 10 or 11, Node 20 or newer, Git.

```powershell
git clone https://github.com/InitiumBuilders/Semble-CC.git
cd Semble-CC
powershell -ExecutionPolicy Bypass -File .\Build-And-Install.ps1
```

The script checks the toolchain, installs from the lockfile, packages, swaps the build in, proves the version by re-reading the binary, keeps the previous build for rollback, puts a shortcut on the desktop, and launches. `npm run deploy` does the same. On a Mac, `bash build-and-install.sh` does the equivalent into `~/Applications`. `npm start` runs from source without packaging on either. Details, switches, what works where, and the uninstall are in [`docs/INSTALL.md`](docs/INSTALL.md).

On first run the gate asks you to set a passphrase (12 characters or more, typed twice). The vault pairs itself to this machine, then looks for a fleet tree under every WSL home it can see: a folder holding `logs/interactions` and `agents`, with the loopback relay on `127.0.0.1:8788`. The relay is a small proxy that turns each message into a Claude Code turn on your own subscription; the console never calls a model provider directly for the fleet. If no tree is found, Pulse says so and points at Config → Preferences. The console opens and runs without one.

## The rooms

Twenty-six views, in six wings. Every view carries its own hue, so a room is recognisable before its name is read.

| Wing | Views | What happens there |
|---|---|---|
| NOW | Pulse · Motus · Goal · Live | The reading of the whole system in one sentence, the engine room, today's receipts. The strongest thing moving now. The north star. Transcripts as they happen. |
| MOVE | Motus Max · Board · Duo-Drive · Workflows · Command · DASH-OPS | Arm an agent to drive the machine. Tasks as a flow with a WIP limit and a close. Loops with a critic. Staged progressions with gates. Chat and slash commands. Voice. |
| FLEET | Agents · Subagents · Sympath · MotusModels | Per-seat model, effort, turns and pause. Real subagent spawns. The healer and learning engine. A studio for loops other people can run. |
| SIGNAL | MotusLive · Output · Work | Broadcast only what you tick. Every deliverable and every image made. The continuity threads. |
| MIND | Systems · Davara · Learn · Next · Usage | Stocks, flows, delays, loops and the attractor. Her organs, her stack, her abilities, her covenant. Learnings that were applied. Proposals with experiments. Real token metering. |
| CORE | Model · Secure · Config · Levels | The pin and the bridge. Provenance and the guard. Settings, integrations, the About panel, bug-test and heal. The quiet room. |

## Two stacks, one fleet

The fleet runs through Claude Code on your subscription. A second seat runs on an OpenAI key you paste on Config → Integrations; it joins the fleet on its own lane and answers `/gpt`. The same key powers the studio, which makes images for every agent (`/image`, the Generate box on Output, or `ci.sh image` from an agent). Seats route by lane. The board, the loops and the workflows do not care which stack answered.

## Talk to it

On Command, plain text goes to the selected agent. These commands do more:

| Command | What it does |
|---|---|
| `/help` | The commands, the agent tool, and links to the guide. Answered locally, no turn spent. |
| `/motusmax <goal>` | Start a drive on an armed Motus Max. Without a goal she reads the system and chooses one. |
| `/reading` | The whole system in one sentence: rhythm, stocks, the attractor. |
| `/leverage <question>` | The strategic read: lever, rung, why now, first step, cost, a divergent frame. |
| `/frames <subject>` | Several frames on one subject, each with a claim, a method and a test. |
| `/map [focus]` | See what she sees: the ecosystem canon at orbit, map or ground altitude. |
| `/gpt <text>` | One turn on the second stack. |
| `/image <prompt>` | The studio. The image lands on Output. |
| Steer · Goal · Motus | The three buttons: a live nudge, the north star, the strongest thing moving now. |

Agents talk back through a tool the app writes for them: `bash ~/.cortexinsight/ci.sh task|doing|done|claim|ask|hand|learn|note|image`. Read `docs/FEATURES.md` for what each verb does and what the app does with it.

## Documentation

- [`docs/README.md`](docs/README.md): the map of every page, with the one loop and the direction of trust drawn out. Start here.
- [`docs/PITCH.md`](docs/PITCH.md): why this console exists, who it is for, what it changes, in five minutes.
- [`docs/FIRST-HOUR.md`](docs/FIRST-HOUR.md): a new operator's first session, told as a story.
- [`docs/GLOSSARY.md`](docs/GLOSSARY.md): the words the console uses.
- [`docs/GUIDE.md`](docs/GUIDE.md): walkthroughs, from the first run to going on air.
- [`docs/FEATURES.md`](docs/FEATURES.md): every feature, what it is for, how it works, and the module behind it.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the processes, the organs of the main process, the data on disk, the harnesses.
- [`docs/EVOLUTIONS.md`](docs/EVOLUTIONS.md): the story of the versions and what each one taught.
- [`docs/FUTURE.md`](docs/FUTURE.md): the agentic future this console is built toward, with falsifiers.
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md): the relay, OpenAI, ElevenLabs, email, and the broadcast to semble.cc.
- [`docs/MOTIVUS-ONE.md`](docs/MOTIVUS-ONE.md): the subscription tier proposal.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): the laws, the ship gate, and how to propose a feature.
- [`SECURITY.md`](SECURITY.md) and [`OPEN-SOURCE.md`](OPEN-SOURCE.md): the threat model and the publishing gate.

## Verify before you trust

```bash
npm run smoke       # renders every view in a sandbox vault, asserts the shipped defaults, writes %TEMP%\ci-smoke-report.txt
npm run clicktest   # times the synchronous work behind every start button, writes %TEMP%\ci-click-report.txt
npm run fresh       # a stranger's first hour: empty vault, no fleet tree, every room walked, writes %TEMP%\ci-fresh-report.txt
npm run gate        # the open-source gate: secret shapes, private names, baked credentials, personal defaults
```

The smoke run never touches your vault. It copies user data into a sandbox, types a throwaway passphrase, and screenshots each view to `%TEMP%\smoke-*.png` and `%TEMP%\mobile-*.png` (a 375 px pass). Read the report before believing the exit code.

## Footprint

Vanilla renderer, no framework. One capped canvas that stops on blur. No blur filters behind it. Tail reads and delta reads over the WSL bridge, never whole files. A frozen index of the past on disk so a cold boot parses about a hundred milliseconds of new lines rather than the whole history.

## License and status

The license is the founder's call and is not chosen yet. Until a `LICENSE` file exists, treat the tree as source-available: read it, run it, open issues, send proposals. The tree was built paired to one machine and one operator, then de-personalised for this release. `OPEN-SOURCE.md` lists what is done and what a first run on a foreign machine still has to prove.

---

Strategic Systems Intelligence Agency. Emergent Systems Design, Evolution, and Systems Gardening. Motus Inspired. Motus Designed.

Solutions For The Data Backed World

*Acta Non Verba.*
