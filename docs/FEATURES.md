# Features

Every feature here is written the same way: what it is, why it exists, how it works, and the module behind it. Read this page to decide whether the console fits your fleet, and to find the code when you want to change something.

The thread through all of them: an instrument that only the operator reads is half built. Each reading below feeds an actor, a prompt, a scheduler, a gate, or a seat choice.

## What each room means

The console was designed from meaning outward. Before a room got its panels it got one sentence, and the panels had to earn their place in that sentence.

| Room | Its meaning |
|---|---|
| Pulse | The shared picture, in one breath. |
| Motus | The prime mover: the one thing in motion now. |
| Goal | The fixed sky you steer by. |
| Live | Watching the work happen is a first-class activity. |
| Motus Max | Hands, bounded. |
| Board | Flow, never storage. |
| Duo-Drive | The partner who moves while you are not looking, and never past the floor. |
| Workflows | A shape that can say no. |
| Command | The keyboard is still the fastest instrument. |
| DASH-OPS | Thinking out loud, with the reply spoken back. |
| Agents | Seats are measured, never declared. |
| Subagents | Fanning out is real, and visible. |
| Sympath | The one whose job is to study the others. |
| MotusModels | A loop someone else can run. |
| MotusLive | Only what you tick leaves the machine. |
| Output | What was actually made. |
| Work | The continuity thread, over the shoulder. |
| Systems | The fleet as Meadows would see it. |
| Davara | Her organs beside the loops that use them. |
| Learn | What recurs is what is true. |
| Next | Proposals that have to prove themselves. |
| Usage | Metered, never faked. |
| Model | The pin, and the bridge that makes it per seat. |
| Secure | Did this really come from my machine? |
| Config | The doors and the keys. |
| Levels | The quiet room. |

---

## The reading

**What.** One sentence that says what the whole system is doing right now: its rhythm over the day, which stocks are filling, which delay is longest, and which attractor the work is falling toward.

**Why.** An operator opens a console to answer one question: what is going on. Twenty panels answer twenty questions. One sentence answers the first one, and the panels answer the rest.

**How.** `systemDynamics()` computes a 24-hour ring of turns, today's and the peak window, stocks (open tasks, waiting questions, learnings, receipts), flows (turns per hour, closes per day), delays (question age, drive pace), loops (which reinforcing loop is turning) and extremes. `systemReading()` compresses it. The sentence renders on Pulse with a rhythm ring, answers `/reading`, and rides first in the brief every agent turn starts with, in every loop prompt, and in the strategic read.

**Module.** `systemDynamics`, `systemReading`, `writeBrief` in `main.js`; `renderReading`, `rhythmRingSvg` in `src/renderer.js`.

## Pulse

**What.** The dashboard: the reading, the engine room (what is being read and how fast), the constellation of seats (live, active, idle, dormant), today's receipts, in-flight NOW cards, recent activity, the focus strip.

**Why.** The first screen should be the shared picture. Everything else is a room off it.

**How.** `buildOverview()` assembles the picture from the readers. NOW cards come from `currentWork()`, which reads the live ask out of the session transcript because the interactions log only lands when a turn completes. Rows expand in place; nothing is truncated.

**Module.** `buildOverview` in `main.js`; `loadOverview` in `src/renderer-v2.js`.

## Motus and Goal

**What.** Two focuses. Goal is the north star, changed rarely, with a two-step confirm. Motus is the single strongest thing moving now.

**Why.** A fleet with no stated focus optimises whatever it last saw. Two horizons keep the day's push and the season's direction from blurring into each other.

**How.** Both are stored in the vault and sent to the agent as a framed message. Motus renders as a gravity well with days held and an alignment current: a deterministic word-overlap between the Motus and the real board that splits tasks into moving and drifting, with no model call. Goal shows a bearing against Motus and an evidence row. Both ride in the brief.

**Module.** `cortex:send` kinds `goal` and `motus`, `cortex:focus` in `main.js`; `loadFocusV2` in `src/renderer-v2.js`.

## Live

**What.** An agent's session transcript, streamed read-only as it happens: reasoning text, tool calls, subagent spawns, file edits, results. Session replay for a finished drive.

**Why.** Watching the work happen is a first-class activity. It is also the fastest way to learn what a prompt did.

**How.** The checkpoint names the session id; the transcript is tailed by byte offset with a delta read. The feed appends rather than rebuilding, trims at 400 rows, and opens files on click. A Hermes gateway log is shaped into events too, with housekeeping noise filtered and duplicates collapsed, never for errors.

**Module.** `liveWatch`, `liveStop`, `hermesToLiveEvents`, `omniReplay` in `main.js`.

---

## The board

**What.** A task manager where the tasks belong to the operator and to the agents. Four lanes, a WIP limit, a flow line, a sweep for stale work, a NEXT tray, a parked section, age chips, and the close.

**Why.** A board that only stores tasks is a list. A board that moves has a limit on what is open, an opinion about what is stale, and a ritual for finishing.

**How.**
- A title carries its own grammar: `!` priority marks, `@agent`, `#tags`, and a park mark. `parseTaskGrammar()` reads it.
- The WIP strip counts open work against the limit and says so when you are over.
- `taskSweep()` names tasks older than three weeks with no movement and offers to park them. A parked task is never scheduled.
- `closeCandidates()` proposes what can be closed today from the transcript evidence; `closeAct()` closes it with a receipt.
- `duoNextAdd/Act` is the NEXT tray: the follow-ups loops and drives propose, one click to make them tasks.
- Auto-work: tasks assigned to an agent run through the scheduler when the budget governor allows, the fastest sound hands first.
- Agents add tasks through `ci.sh task`, mark them `doing` and `done`, `claim` them so two seats do not collide, and `ask` a question that lands as a waiting task assigned to the asker.
- A `done` claim is corroborated by `evidenceFor()`: completed turns since the task was created, files written in the window, and word overlap between the title and the work. The result is strong, partial or thin, written onto the task. A negated completion in a note ("not done yet") is not a claim; negation is read by adjacency, never by presence.

**Module.** `cortex:board`, `taskCreate/Update/Delete/Dispatch`, `parseTaskGrammar`, `taskSweep`, `closeCandidates`, `closeAct`, `duoNextAct`, `evidenceFor`, `autoWorkTick` in `main.js`; `loadBoard` in `src/renderer-v2.js`.

## Duo-Drive and the leverage loops

**What.** An autonomous partner that runs approved loops on a cadence, each loop a kind (design, refine, review, compound, scout, artifact) with an instruction, a confidence floor, and a project scope. A completed-work ledger with a verdict per pass: shipped, reported or skipped.

**Why.** The flywheel an operator runs by hand (mantra, mindset, model, motus) made portable. The one-line test on every pass: did something actually move? A brilliant observation that changed nothing is skipped honestly rather than dressed up.

**How.**
- Every pass opens with the creed, the systems sight (read stocks, loops, delays and the rung before acting), the organs of Davara's baseline for that loop kind, the project's ethos, the reading, and the guardrails: refinement only, never refactor broadly, never touch auth or keys or deploy, never decide on autopilot, and below the confidence floor do nothing and say so.
- The report shape is a contract: TITLE, CONFIDENCE with BASIS, FALSIFIER with a clock, SHUTTLE, DID, FILES, NEXT. `LOOP_CRITIC` runs before the report: name the three strongest objections, say what a number counts before citing it, walk one lived turn, no falsifier no move.
- `receiptQuality()` scores the report 0 to 10 from what it carries. A named file that does not exist downgrades shipped to reported. Low quality stretches the loop's cadence; a skipping loop waits longer; quality also decides which seat is the fastest sound hands.
- She can author a loop from any pass. It is saved unapproved and disabled. The operator approves, revises or rejects. That is the whole safety model: she may evolve her playbook and never silently run it.
- The pass log, the work log with quality chips, the project registry with per-project ethos, and the design ethos she reads before touching anything are all on the Duo-Drive view.

**Module.** `LOOP_KINDS`, `DUO_MODES`, `LOOP_CONTRACT`, `LOOP_CRITIC`, `LOOP_GUARDRAILS`, `duoPass`, `duoLoopPass`, `nextDueLoop`, `cadenceStretch`, `loopQualityStretch`, `receiptQuality`, `fileLikelyExists`, `parseLoopProposal`, `ensureLoopSeeds` in `main.js`; `loadDuo` in `src/renderer-v2.js`.

## Workflows

**What.** Staged progressions. Each stage has one or more seats and an instruction, receives the prior stage's handoff, and can be a gate. Runs can be estimated, resumed, and armed on triggers.

**Why.** Some work is a shape: build, then review, then heal. A workflow makes the shape reusable, and the gate makes "unsafe, do not ship" an outcome the machine respects.

**How.**
- Up to twelve stages. Several seats in one stage run in parallel. Each stage ends with a HANDOFF of at most 200 words; only that travels forward. Full replies are stored.
- A gate stage must answer `VERDICT: PASS|BLOCK`. A BLOCK halts the run, files a priority-1 task with the reason, and notifies. A PASS at confidence below 5 is treated as a block. Every stage carries its CONFIDENCE and FALSIFIER; the run history shows the chip.
- Resume restarts from the stage after the last success, seeded with its real output. Completed stages are never paid for twice. Runs orphaned by a restart are swept to stopped on boot.
- Triggers arm a workflow on a fault, a task landing from an agent, or a Duo pass, with an optional match, a cooldown, and one workflow per event.
- The Run confirm shows the estimate beside the position in the five-hour window.
- Seeds ship: Build → Review → Heal, Deep diagnose, Fan-out research, Adversarial review (gated).

**Module.** `wfNormalize`, `wfSave`, `wfRun`, `wfResume`, `wfEstimate`, `fireTriggers`, `sweepZombieRuns`, `wfSeeds` in `main.js`; `loadWorkflows` in `src/renderer-v2.js`.

## Command

**What.** Chat with any seat, the three buttons (Steer, Goal, Motus), and the slash commands listed in the README.

**Why.** The keyboard is still the fastest instrument. The commands put the strategic read, the reading, the map, the studio and the second stack one line away.

**How.** `cortex:send` matches the command, otherwise frames the message by kind and posts it to the relay. Every sent message is stamped with a provenance record.

**Module.** `cortex:send`, `strategicRead`, `divergentFrames`, `mapCortex` in `main.js`.

## DASH-OPS (voice)

**What.** A voice console. Call mode listens, sends, speaks, listens. Push-to-talk holds a key. A live orb shows listening, thinking and speaking. Voice steering during a drive.

**Why.** Some operators think out loud. A drive you can steer by voice is a drive you can watch with your hands off the keyboard.

**How.** Speech recognition runs locally in the renderer; your voice never leaves the machine through this app. Only the agent's reply text goes to ElevenLabs, from the main process, with a sealed key. Replies for the ear are short and free of markup; `speakable()` strips code, links and markup and caps the length. Permissions are granted only for media capture; everything else is denied.

**Module.** `cortex:voiceTurn`, `cortex:speak`, `cortex:transcribe`, `elevenRequest`, `speakable` in `main.js`; `loadVoice` in `src/renderer-v2.js`.

## Motus Max (OmniDrive)

**What.** The layer where an agent stops advising and starts operating the machine: files, commands, APIs, and the screen when the screen is the right instrument. A HUD over every display shows she is driving. A panic key stops it.

**Why.** An agent that can only advise leaves every change to the operator's hands. This layer lets her make the change herself, and the console keeps each move visible, bounded and reversible.

**How.**
- Arm on the Motus Max view. Only your hand arms it: no command, no agent, no spoken word can. The arm has a time to live, a scope (guarded: only allow-listed windows; open: anything but the denylist), a pacing (auto, or ask before every batch), and a step budget.
- The pre-read: the moment you arm, the strategic read runs, so a drive with no goal starts on a chosen lever with a first step. A read she was not sure of makes the first batch wait for your tap.
- She has instruments before she has eyes. `[[OS:read]]` reads a file, URL or directory under your home roots; `[[OS:api]]` calls an endpoint, with writes confined to your own hosts; `[[OS:work]]` runs a command; `[[OS:show]]` opens a file, a URL or a window so you can see; `[[OS:see]]` and `[[OS:look]]` take and zoom a frame only when the goal is GUI-shaped. The adaptive interface engine gives her the instruments that fit the foreground window's family.
- The reflex router sends cycles whose plan is already set to the leanest sound seat, and returns every plan-forming cycle to the mind. Seats are measured, never declared: the seat clock reads each seat's pace from its transcripts.
- Guards: protected windows are refused, credential-shaped text is never typed or sent, there is no shell verb on the screen path, and every cycle writes to an audit log. Sessions can be replayed.
- Chains: continuous mode makes the next move after a done, up to a chain limit, and banks a lesson per drive.

**Module.** `omniDefaults`, `omniStart`, `omniFlow`, `omniPreRead`, `omniRouteCycle`, `ENV_FAMILIES`, `omniReadTarget`, `omniApi`, `omniCompile`, `omniSecretish`, `overlayWin`, `seatClock`, `fastestHands` in `main.js`; `loadOmni` in `src/renderer-v2.js`; `src/overlay.html`.

---

## Agents, Subagents, the bridge, the brief

**What.** Per-seat model, effort, turn budget and pause, resolved from one registry and delivered to the runner every turn. Real subagent spawns, visible. A shared brief at the start of every turn.

**Why.** Without the bridge, the model pin is a line in a shell script and every seat runs at one depth. Without the brief, every turn starts blind, including every message from a phone.

**How.** The registry (`FLEET`) is the single source of truth. The bridge is one guarded block in the runner that reads `fleet.json` fresh each turn and wraps the CLI with the effort flag; install and uninstall are one click with backup and rollback. The brief carries the reading, the focuses, the open board and the strongest learnings, capped at two thousand characters. Subagents are read from the transcript (Task and Agent calls) and can be spawned with distinct lenses and a synthesis step.

**Module.** `FLEET`, `agentCfg`, `publishFleetConfig`, `installBridge`, `bridgeStatus`, `writeBrief`, `parseSubagents`, `subagentFleetPrompt` in `main.js`.

## Sympath and Arden

**What.** Sympath-Cortex is the healer and the learning engine: it reflects on the fleet's telemetry and banks learnings with a conviction score. Arden observes the system on a long cadence and leaves reflections with a Meadows lever; high-conviction levers become next steps.

**Why.** A fleet needs a seat whose job is to study the others. Two seats with different cadences and different stances see different things.

**Module.** `doReflect`, `runArden`, `cortex:ardenObserve` in `main.js`; the Sympath and Levels views.

## MotusModels

**What.** A studio for loops that someone else can run. A MotusModel has an essence, a mantra, a mindset, a model and a motus; it is scored on portability, payout, mover-pull, proof and resonance; it moves from draft to ratified to minted to broadcast, with a lineage.

**Why.** MotusModels exist so that a loop can be run by someone who did not write it, and so that each run leaves a receipt that proves it happened.

**Module.** `MM_AXES`, `MM_STATUS`, `newMotusModel`, `cortex:mm*` in `main.js`.

---

## MotusLive (broadcast)

**What.** A desk for putting selected work on a public page, with a chosen persona from the pantheon, a topic, and only the items you tick.

**Why.** The founder's words set the law: "nothing ever private or security stuff. Only the stuff I select." The desk exists so that sharing is a choice made item by item, and so that off means off.

**How.** Candidates are gathered (focuses, the open thread, open tasks, recent moves, per-agent focus lines, custom notes). Nothing is selected by default. Only ticked items enter the payload. Every string passes the secret gate and anything flagged is dropped and counted. The server re-scrubs on arrival. When the broadcast is off, the payload carries `on:false` and nothing else. The host is a setting. Verify compares what the site shows to what was sent; enforce corrects it; the drift watch alarms when they diverge. The pantheon ids stay in lockstep with the site so it can retune to the chosen persona.

**Module.** `onAirDefaults`, `onAirCandidates`, `onAirPayload`, `onAirPush`, `onAirVerify`, `onAirEnforce`, `onAirDrift`, `ONAIR_DJS` in `main.js`.

## Output and the studio

**What.** Every deliverable: ask and delivery from the memory threads, every file the agents wrote with open and reveal buttons, and every image the studio made.

**How.** Files come from Write and Edit calls in the transcripts, joined to a project by path. The studio makes images with the OpenAI key, under a per-day cap, for you (`/image`, the Generate box) and for agents (`ci.sh image`). Images live in user data and render through a `file:` image source allowed by the CSP.

**Module.** `cortex:outputs`, `transcriptFileWrites`, `imageGenerate`, `studioList`, `studioDelete` in `main.js`; `renderStudio` in `src/renderer.js`.

---

## Systems

**What.** The fleet as Meadows sees it: measured stocks, the reinforcing and balancing loops, the iceberg, and a leverage ladder where every rung maps to a real control in the app. An act-here-first panel computes structural readings of the live system and gives each one a working button. The strategic read and divergent frames on demand.

**Module.** `cortex:systemInsight`, `strategicRead`, `divergentFrames`, `mapCortex` in `main.js`; `loadSystems` in `src/renderer-v2.js`.

## Davara

**What.** Her abilities, in one room: the organs each loop kind invokes, the stack ladder with trust and mutability per layer, the recent stream, the command library, the abilities panel, and the covenant with a button that runs one ceremony.

**Why.** An agent's baseline is a living canon. Reading it beside the loops that use it shows what a pass is actually made of.

**How.** Read live from a baseline clone in the WSL home. When no clone exists the view says so and the loops run without the organs.

**Module.** `dvDir`, `dvRead`, `dvSection`, `dvOrgansFor`, `mindReport` in `main.js`; `loadMind` in `src/renderer-v2.js`.

## Learn and Next

**What.** Learnings derived from telemetry and banked by reflections, with a use count that grows when a learning recurs and an applied count when it shows up in closed work. Next steps: measured proposals with an apply button and a before-and-after experiment that reverts what measured worse.

**Module.** `deriveInsights`, `doReflect`, `learningsApplied`, `generateProposals`, `applyLever`, `concludeExperiments` in `main.js`.

## Usage and the governor

**What.** Real token metering from transcript usage blocks, per model, in five-hour, daily and weekly windows, with a burn rate. Soft caps you set. A governor that tiers autonomous spend: open, trim, hold.

**Why.** Subscription caps are not exposed locally, so the app never fakes a percentage. It meters what was spent and compares to your own caps. Anything you trigger by hand always runs; the governor defers only autonomous work.

**Module.** `usageRefreshAsync`, `budgetState`, `autonomyAllowed` in `main.js`.

---

## Secure and the Sentinel

**What.** The guard state, the signals that passed, provenance on every command, an injection watch that surfaces and never blocks, the integrity monitor over the critical fleet files, the watchdog with native notifications gated by presence, the tray icon that carries the fleet's pulse, and the stop button with an honest scope.

**How.** Soft stop halts everything the console drives. Hard stop writes a pause into `fleet.json` so the runner itself refuses turns, which also stops messages that arrive from elsewhere; it requires the bridge, and the app says so loudly when it is not in force. A separate gateway seat is never covered by either.

**Module.** `GUARD`, `integrityCheck`, `watchdogTick`, `controlState`, `dispatchBlocked`, `midFlow` in `main.js`.

## Config, Integrations, About

**What.** Preferences, Sentinel toggles, autonomy settings, the canary email, voice, OpenAI, the About panel, and the bug-test and heal panel with a health score and one-click remedies.

**How.** Keys are verified against the provider, then sealed. The About panel carries the founder's lines verbatim and links to the source and the live surface.

## Self-update

**What.** The running app notices a newer build staged beside its project tree and swaps itself, proving the swap by re-reading the version.

**Why.** "You are two versions behind" was the quiet cause of half the bugs reported before it existed. A swap that fails silently is worse than none, so this one polls, retries, verifies and rolls back.

**Module.** `stagedBuild`, `projectRoot`, `cortex:updateApply` in `main.js`; `Update-MotusMax.ps1` at the root for a manual swap.

## The harness

**What.** `--smoke` renders every view in a sandbox vault with a throwaway passphrase, asserts the shipped defaults and every feature contract, screenshots each view at desktop and at 375 px, and writes a report. `--clicktest` times the synchronous work behind every start button, cold and warm, after deleting cache artefacts so cold means cold. The open-source gate scans the tree for secret shapes and personal defaults.

**Why.** An exit code of zero proves only that the process ended. The report proves what ran, so read the report.

**Module.** `runSmoke`, `runClickTest`, the `ok()` and `problems.push('[TAG] …')` assertions in `main.js`; `scripts/oss-check.js`.
