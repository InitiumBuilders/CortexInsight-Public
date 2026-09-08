# Glossary

The console uses a small vocabulary on purpose. Most of these words appear on screen; the rest appear in the code and in these docs. Where a word comes from the founder's own lexicon, it is kept as he wrote it.

## The people and the seats

**Operator.** The person the console serves. There is one per vault. The operator's hand is the only thing that can arm Motus Max.

**Seat.** One agent identity the fleet can run: a name, a lane, a tone, a role, an effort, a turn budget, and whether it can code. The registry (`FLEET` in `main.js`) is the single source of truth.

**Lane.** How a seat is reached. `relay` seats go through the loopback relay on the operator's Claude Code subscription. The `openai` seat goes through an OpenAI key. An `openrouter` seat runs in its own gateway and is observed, never relayed.

**Davara, Davaris, Davari.** The mind, the builder, the quick hands. Davara carries a baseline of organs and protocols; Davaris ships code; Davari builds at full depth without re-reading herself first.

**Sympath-Cortex.** The healer and the learning engine. Reflects on the fleet's telemetry and banks learnings with a conviction score.

**Arden.** The observer. Leaves reflections on a long cadence, each with a lever. Lives in the Levels view.

**Workhorse.** The lean infra seat with no identity. Takes cycles whose plan is already set.

**The GPT seat.** The second stack, on the operator's OpenAI key. Answers `/gpt`.

## The rooms

**Wing.** A group of views in the rail: NOW, MOVE, FLEET, SIGNAL, MIND, CORE.

**Pulse.** The dashboard. The reading, the engine room, today's receipts, the constellation.

**The reading.** One sentence about the whole system: its rhythm, its stocks, its attractor. Rides first in the brief.

**The engine room.** The strip on Pulse that says what is being read and how fast, and whether Motus Max has a move ready.

**Motus.** The single strongest thing moving now. Shorter horizon than the Goal. The founder's word.

**Goal.** The north star. Changed rarely, with a two-step confirm.

**The well.** The Motus room's drawing of alignment: work that shares the Motus's words orbits close, work near it sits on the middle ring, work that shares none drifts on the outer ring.

**Sharpen.** One relay turn that returns one line and one falsifier for a focus. It proposes; the operator uses it or does not.

**The ladder.** The Goal room's descent from the star to the Motus to today's turns and closes, and back up as learning.

**Her console.** The panel on the Davara room that asks her through one chosen protocol, with the reply inline.

**Local intent.** A spoken ask the app answers by itself with no turn: the reading, the board, the arm, the clock, a room by name.

**The Board.** Tasks as a flow: four lanes, a WIP limit, the sweep, the close, the NEXT tray.

**Duo-Drive.** The autonomous partner that runs approved loops on a cadence. Also the first MotusAgent.

**Motus Max.** The layer where an agent operates the machine: files, commands, APIs, and the screen when the screen is the instrument. Also called OmniDrive in the code.

**DASH-OPS.** The voice console. Call mode and push-to-talk.

**MotusLive.** The broadcast desk. Only ticked items leave the machine.

**MotusModels.** The studio for loops that someone else can run.

**Levels.** The quiet room where Arden leaves reflections.

**The Davara view (Mind).** Her organs, her stack, her abilities, her covenant.

## The board's words

**Task grammar.** Marks in a title that the board reads: `!` for priority, `@seat` to assign, `#tag` to tag, `~park` to park.

**WIP limit.** How much may be open at once. The strip says so when you are over.

**The sweep.** The list of work older than three weeks with no movement. Park it or close it.

**Parked.** Set aside on purpose. A parked task is never scheduled.

**The close.** Three decisions a day, chosen from the ledger: a claimed done that never moved, a long wait, the oldest priority. Each is one press.

**The NEXT tray.** Follow-ups proposed by loops and drives, one click from becoming tasks.

**Verified done.** A done claim corroborated against the transcript: strong, partial or thin.

**Auto-work.** Tasks assigned to a seat that the scheduler runs when the governor allows.

## The loop's words

**Loop.** The primitive of Duo-Drive: a kind, an instruction, a cadence, a confidence floor, a project scope. Approved and enabled separately.

**Kind.** Design, refine, review, compound, scout, artifact.

**Stance.** How Duo-Drive works when no loop is due: complement, harden, scout, compound, design, motivus.

**Pass.** One run of a loop. Ends with a report in the contract shape.

**The contract.** TITLE, CONFIDENCE with BASIS, FALSIFIER with a clock, SHUTTLE, DID, FILES, NEXT.

**The critic.** The four checks a pass runs before it reports: the strongest objection, what the number counts, one lived turn, no falsifier no move.

**Receipt.** What a pass leaves behind: the report, its verdict, its quality score.

**Verdict.** Shipped, reported, or skipped.

**Quality.** A score from 0 to 10 read off the receipt itself. Feeds the cadence and the seat choice.

**Falsifier.** The observation, by a stated time, that would prove a move wrong.

**The shuttle.** One lived turn walked through a change, start to finish, as a real user would live it.

**Organs.** Sections of Davara's baseline that a loop kind invokes: what she reads before she acts.

**Ethos.** The house design language a design loop reads before touching anything. Editable, so taste compounds.

**The creed.** Mantra, Mindset, Model, Motus. Opens every pass. The one-line test: did something actually move?

## The workflow's words

**Stage.** One step with one or more seats and an instruction.

**Carry.** What travels from one stage to the next: the HANDOFF, at most 200 words.

**Gate.** A stage that must answer PASS or BLOCK. A BLOCK halts the run and files a task.

**Resume.** Restart after the last successful stage with its real output.

**Trigger.** An event that arms a workflow: a fault, a task landing, a Duo pass.

**Estimate.** The price of a run in input tokens, shown beside the five-hour window.

## Motus Max's words

**Arm.** The operator's hand on the switch. Has a time to live.

**Drive.** A session with a goal, a step budget, and an audit trail.

**Cycle.** One perceive, decide, act turn inside a drive.

**Pre-read.** The strategic read that runs the moment you arm, so the drive starts on a chosen lever.

**Scope.** Guarded (only allow-listed windows) or open (anything but the denylist).

**Pacing.** Auto, or ask before every batch.

**Mode.** Auto, work (files, commands, APIs), or screen (the pointer).

**Instruments.** Her verbs in double brackets: read, api, work, show, see, look, click, type, key, focus, launch, visit, wait, and the speech verbs.

**The show law.** She must show the operator what she changed. `[[OS:show]]` exists for that.

**Reflex.** The router that sends set-plan cycles to the leanest sound seat.

**The seat clock.** Each seat's measured pace, read from its own transcripts.

**HUD.** The transparent window over every display that says she is driving.

**Panic key.** The global key that halts everything.

## The fleet's words

**The fleet tree.** The folder in the WSL home that holds the fleet's logs, checkpoints, transcripts, memory and runner scripts. Read, never rewritten.

**The relay.** The loopback proxy that turns a message into a Claude Code turn.

**The bridge.** One guarded block in the runner that reads per-seat config every turn and prepends the brief.

**The brief.** The shared orientation every turn starts with: the reading, the focuses, the open board, the strongest learnings.

**The inbox.** The append-only queue agents write to with `ci.sh`.

**The governor.** The tiering of autonomous spend against the operator's own caps: open, trim, hold.

**Soft stop, hard stop.** Halt what the console drives; make the runner itself refuse turns.

## The console's words

**The vault.** The app's own state file in user data. Sealed secrets live in it as ciphertext.

**Sealed.** Encrypted with the OS keystore. The renderer never sees a key.

**The gate.** The passphrase screen. On a fresh vault it asks you to set one.

**Paired.** The vault knows the machine that created it.

**The canary.** The record and the alert when a copied vault opens elsewhere.

**Sentinel.** The watchdog, the integrity monitor, the tray icon carrying the fleet's pulse.

**The frozen index.** The past interactions, parsed once and kept on disk, so a boot reads only the growth.

**Stale-while-revalidate.** Answer from cache now, refresh behind, return the in-flight promise while a refresh runs.

**Neoglass.** The house material: layered, lit by the view's hue, no blur behind the canvas.

**The harness.** The smoke, the click test, the fresh test, the gate. What proves a build before anyone believes it.

## The founder's words, kept as written

**Motus Is The Mindset. The Mindset Means Move.**

**Presented By Outlier.Systems**

**This Is A Service From Motivus.One**
