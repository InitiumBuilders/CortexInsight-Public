# The build prompt

A complete prompt for rebuilding CortexInsight from nothing, with an agent that can read, write and run code. It carries the meaning, the laws, the shape, every feature with its acceptance test, the build order, and the ship gate. Hand it to Claude Code in an empty folder and work through the phases; run the harnesses at the end of each one.

It is also the honest description of what this console is. If the prompt and the tree ever disagree, the tree is wrong or the prompt is stale, and either is a bug.

## How to use it

1. Make an empty folder and open an agent session in it.
2. Paste everything below the line into the first message. Say which phase to start with (phase 1 unless you are resuming).
3. After each phase, run the harnesses the phase names. Do not start the next phase on a red harness.
4. Keep this document beside the tree. When a feature changes, change its paragraph here first.

---

# PROMPT

You are building **CortexInsight**: a desktop operator console over a local fleet of coding agents. Presented By Outlier.Systems. This Is A Service From Motivus.One. It runs on the operator's own machine, reads what the fleet already writes, and closes the loop between what an agent did and what it is told next without a human carrying the state by hand. Build it in the order given, prove each phase with the harness named, and never ship a claim without a receipt.

## 1. Meaning first

Before any code, hold these five sentences. Every element you build must earn its place in one of them.

1. The fleet's own files are the source of truth. The console reads them live and never rewrites them.
2. An instrument that only the operator reads is half built. Every reading must feed a non-human decision: a prompt, a priority, a cadence, a seat choice, a gate.
3. Agents append; the app applies; the operator arms. Nothing in the system runs the other way.
4. Receipts over claims. A confidence with its basis, a falsifier with a clock, a file that exists. A claim without a receipt is reported, never shipped.
5. Off means absent. A service turned off leaves nothing on the wire; a cleared key leaves no ciphertext; a parked task is never scheduled.

## 2. The laws

**Trust.** Read-only on the fleet tree except one guarded block in the runner (backed up, syntax-checked, rolled back on failure) and two explicit levers (model pin, turn budget) that are confirmed and backed up. Agents write only to an append-only queue that the app validates and applies under operator caps. Only the operator's hand, on a switch in the app, arms the layer that operates the machine; no command, agent, trigger or voice path may arm it. Provider keys are verified against their provider before they are sealed with the OS keystore; the renderer receives booleans, never keys, ciphertext or the passphrase hash. Nothing phones home unless the operator turned a service on.

**Honesty.** Every autonomous pass and every workflow stage reports in the contract: TITLE, CONFIDENCE n/10 with BASIS, FALSIFIER with a clock, SHUTTLE (one lived turn walked through the change), DID, FILES, NEXT. A claim of done is corroborated against the transcript. Negation is read by adjacency ("could not complete") never by presence of the word "not" anywhere. Harness exit codes prove only that a process ended; the report proves what ran.

**Performance.** No synchronous file work behind a click. Anything touching the fleet tree is asynchronous, single-flighted (a refresh in flight is returned, never duplicated), stale-while-revalidate. Read the growth, never the history: delta reads with a carry, a frozen index of the past on disk, stat-gated caches. One canvas, capped at 20 fps, stopped when hidden, with no blur filter behind it. Render a panel only when its data changed. Poll at seven seconds.

**Design.** Text is never sliced in JavaScript; render whole, clamp in CSS, open on click. Nothing sharp-cornered. No grey or low-contrast text; hierarchy from size and weight. Glow, never highlight. No box or ring on icons and buttons. Strips of five or four, never a three-plus-two orphan. Every view carries its own hue through a registered CSS property that eases between rooms. Verified at 375 px. Motion is transform and opacity, with springs, and nothing animates while hidden.

**Words.** The founder's lines are verbatim. Copy you write is plain: no staging, no closers, no dashes as connectors, no inflated significance.

## 3. The shape

One Electron app. `main.js` is one long file in organ order, read top to bottom, with banners between organs. `preload.js` exposes one named channel per IPC handler as `window.cortex`. `src/index.html` holds twenty-six view sections, the titlebar, the gate and a reader modal. `src/renderer.js` holds the navigation list, `setHTML` (hash-gated, pulses a change once), the gate, Pulse, Settings and the reader. `src/renderer-v2.js` redefines same-named view functions with richer bodies. `src/overlay.html` is a transparent click-through window over every display for the driving HUD. Vanilla renderer, no framework, one dependency in the main process (a mailer for the canary).

The renderer is sandboxed: context isolation, no node integration, a Content Security Policy that allows self, fonts, `data:` and `file:` images, and `blob:`/`data:` media. Every IPC handler is wrapped so it refuses until the gate has been passed and turns thrown errors into `{ error }`.

Data on disk: the vault (`cortex-insight-state.json` in user data, atomic writes, a `.bak`, forward-merged defaults), a frozen index of past interactions, integrity snapshots, studio images; and in the fleet's home, `~/.cortexinsight/` holding the per-seat config the bridge reads, the brief, the agent tool and its manual, the append-only queue, and minted models.

One platform seam: Windows reaches a fleet tree in WSL through a UNC path and crosses the bridge with `wsl.exe`; macOS reads a folder in the home and runs the shell directly. Features that exist on one platform say so in their result.

Twenty-six rooms in six wings. NOW: Pulse, Motus, Goal, Live. MOVE: Motus Max, Board, Duo-Drive, Workflows, Command, DASH-OPS. FLEET: Agents, Subagents, Sympath, MotusModels. SIGNAL: MotusLive, Output, Work. MIND: Systems, Davara, Learn, Next, Usage. CORE: Model, Secure, Config, Levels.

## 4. The features, each with its acceptance

Build each one so that its acceptance line is a harness assertion.

**The gate.** A passphrase screen. A fresh vault opens in setup mode: twelve characters or more, typed twice, hashed into the vault. The vault pairs itself to the machine that created it; a copied vault on another machine sees a decoy state and the original records the attempt. *Accept: a fresh vault sets a passphrase and pairs; setup refuses a second passphrase; the hash never reaches the renderer.*

**Readers.** Parse the interactions log, the checkpoints, the session transcripts and the memory threads. Delta reads with a carry. A frozen index on disk so boot parses the growth. A live "now" reader that pulls the in-flight ask from the transcript, because the log only lands when a turn completes. Real token metering from transcript usage blocks in five-hour, daily and weekly windows. *Accept: boot parses in about a hundred milliseconds on a live log; the click behind every start button is under two hundred milliseconds; a refresh in flight is returned, not duplicated.*

**The fleet registry and the bridge.** One registry of seats: id, name, lane, tone, role, effort, turn budget, whether it codes. Every screen derives from it. A bridge: one guarded block in the runner that reads per-seat config fresh each turn and wraps the CLI with the effort flag; install and uninstall in one click with backup and rollback. *Accept: eight isolated cases pass, including a shell-injection attempt in the model field being rejected and the brief being prepended with the original message preserved last.*

**The brief.** Written on every change, capped at two thousand characters, prepended to every message by the bridge. Order: the operator's name, the reading, Motus, Goal, the open board with short ids, the strongest learnings ranked by endorsement, recurrence and application in closed work. *Accept: the reading is within the first two thousand characters of the brief.*

**The inbox.** The app writes an agent tool and its manual on every boot. Verbs: task, doing, done, claim, ask, hand, learn, note, image. Each appends one JSON line; the app reads forward from a persisted byte offset, consumes only complete lines, validates, and applies under caps: delegation propose-only at zero, images against a per-day cap. *Accept: a done claim is corroborated against the transcript into strong, partial or thin; a parked task is never scheduled; a negated completion is not a claim.*

**The board.** Four lanes, a WIP limit, a flow line, task grammar in titles (`!` priority, `@seat`, `#tag`, `~park`), a sweep for three-week-stale work, THE CLOSE proposing three decisions a day from the ledger, a NEXT tray of proposed follow-ups, auto-work through the scheduler when the governor allows. *Accept: the grammar parses; the sweep names stale work; the close proposes from claimed-done, long-wait and oldest-priority; parked tasks are skipped.*

**Duo-Drive and the leverage loops.** A loop is the primitive: kind (design, refine, review, compound, scout, artifact), instruction, cadence, confidence floor, project scope, approved and enabled separately. Every pass opens with the creed (Mantra, Mindset, Model, Motus; the one-line test: did something actually move?), the systems sight, the organs of the mind's baseline for that kind, the project's ethos and the reading; then the guardrails; then the contract and the critic. Receipt quality is scored 0 to 10 from the report itself; a named file that does not exist downgrades shipped to reported. Low quality stretches the cadence; a skipping loop waits longer; quality decides which seat is the fastest sound hands. An agent may author a loop; it lands unapproved and disabled. A cadence pass whose context signature has not changed is skipped at zero cost. *Accept: a full report scores 10 and a thin one 1; a low-quality loop waits twice as long; an authored loop cannot arm itself.*

**Workflows.** Up to twelve stages, seats in parallel within a stage, a handoff of at most two hundred words as the only carry. Gates answer PASS or BLOCK; a BLOCK halts and files a priority-1 task; a PASS below confidence 5 is a block. Resume from the stage after the last success with its real output. Triggers on fault, task and Duo pass with cooldown, one workflow per event. An estimate in input tokens beside the five-hour window. *Accept: a blocked gate halts and files; a low-confidence pass blocks; resume never repays a completed stage.*

**The reading and the dynamics.** Compute a 24-hour ring of turns, today's and the peak window, stocks, flows, delays, loops, extremes, and an attractor. Compress it into one sentence. Render it on Pulse with a ring, answer it on Command, and ride it first in the brief and in every loop prompt and strategic read. *Accept: the reading is non-empty on a vault with history and honest on an empty one; the brief carries it first.*

**Motus Max.** The layer that operates the machine. Armed only by the operator's hand, with a time to live, a scope (guarded: allow-listed windows; open: anything but a denylist), a pacing (auto or ask), a step budget. A pre-read: the strategic read runs the moment the switch is held so a drive starts on a chosen lever; a read below confidence 6 makes the first batch wait for a tap. Instruments before eyes: read a file, URL or directory under the operator's home roots; call an API with writes confined to the operator's own hosts; run a command; show a file, URL or window; see and look at the screen only when the goal is GUI-shaped. An adaptive interface engine gives instruments by window family. A reflex router sends set-plan cycles to the leanest sound seat, measured by a seat clock read from transcripts. A HUD over every display, content-protected so her own frames never show it. A global panic key. Protected windows refused; credential-shaped text never typed or sent; an audit line per cycle; session replay. *Accept: nothing armed means nothing runs; a read outside the roots is refused; a secret-shaped prompt is refused before any key is read; the panic key is bound.*

**Command.** Chat with any seat; Steer, Goal, Motus; `/help`, `/reading`, `/leverage`, `/frames`, `/map`, `/motusmax`, `/gpt`, `/image`. Provenance stamped on every sent message. *Accept: `/help` answers locally with no turn spent.*

**DASH-OPS.** Voice. Speech recognised locally in the renderer; only the reply text goes to the voice provider from the main process; the key adopted from a conventional file or pasted, proven against the provider before sealing. Call mode and push-to-talk. Voice steering during a drive. *Accept: the speech seam breaks cleanly; a key that does not answer is refused.*

**The second stack and the studio.** An OpenAI key verified against the models list and sealed; a GPT seat on its own lane; image generation for the operator and for agents under a per-day cap, landing on Output. The same secret-shape guard stands at this door. *Accept: without a key the studio refuses with a reason; a secret-shaped prompt is refused before any key is read.*

**MotusLive.** Broadcast only what is ticked. Candidates gathered, nothing selected by default, every string through the secret gate, the server re-scrubbing on arrival, and when off the payload carries `on:false` and nothing else. The host is a setting. Verify, enforce, drift watch. The founder's law, verbatim: "nothing ever private or security stuff. Only the stuff I select." *Accept: off-air emits nothing but the flag; a secret-shaped item is dropped and counted.*

**MotusModels.** A studio for loops someone else can run: essence, mantra, mindset, model, motus; scored on portability, payout, mover-pull, proof, resonance; draft, ratified, minted, broadcast; a lineage.

**The mind.** Read a baseline clone from the fleet's home: organs per loop kind, a stack ladder with trust and mutability per layer, the recent stream, the command library, the abilities (every protocol's own WHEN line), the covenant with a button that runs one ceremony. Say plainly when no clone exists.

**Learn, Next, experiments.** Learnings derived from telemetry and banked by reflections; recurrence reinforces rather than duplicates; application in closed work outranks recurrence. Proposals with an apply and a before-and-after experiment that reverts what measured worse. A finding that persists across two watchdog sweeps becomes a task that closes itself when the condition clears.

**The governor.** Tier autonomous spend against the operator's own caps: open, trim, hold. Anything the operator triggers by hand always runs.

**Secure and the Sentinel.** Fingerprint and corroboration signals, provenance on every command, an injection watch that surfaces and never blocks, an integrity monitor over the critical fleet files, a watchdog with presence-gated native notifications, a tray icon carrying the fleet's pulse, a soft stop (everything the console drives) and a hard stop (the runner itself refuses turns; requires the bridge; the app says loudly when it is not in force).

**Config, Integrations, About.** Preferences, the operator's name, Sentinel toggles, autonomy, the canary email, voice, OpenAI, the About panel carrying the founder's lines verbatim and links to the source and the docs, a bug-test and heal panel.

**Self-update.** Notice a newer build staged beside the project tree; swap it in with a script that polls for exit, retries the rename, verifies the version, rolls back on failure, and deletes staging only after proof.

**The harnesses.** `--smoke`: a sandbox copy of the vault, every view rendered, every feature contract asserted, screenshots at desktop and 375 px, a report file. `--freshtest`: an empty vault, no fleet tree, the setup gate, every room, a failure on any room that throws, stays blank, is painted invisible, or leaves the operator without a next step; captures taken after real frames. `--clicktest`: synchronous work behind every start button, cold and warm. An open-source gate that scans every file that ships for secret shapes, private names, tunnel hostnames, baked credentials and personal defaults, proven on planted decoys. A continuous build that runs the gate, the fresh harness and the packager on Windows and macOS runners on every push, and turns a version tag into a Release.

## 5. Build order

Phase 1, the mirror: vault, gate, readers, Pulse, Agents, Tasks list, Command, Secure, Config. Harness: smoke renders every view.
Phase 2, the nervous system: registry, bridge, brief, inbox, board, workflows, Live with NOW cards, Output. Harness: the eight bridge cases; the inbox round trip.
Phase 3, the loops: loops with the contract and the critic, the work ledger, projects and ethos, the governor, gates, resume, triggers, verified done, the close. Harness: receipt quality fixtures; gate fixtures.
Phase 4, the hands: Motus Max with instruments before eyes, the HUD, the panic key, the pre-read, the seat clock, the reflex router. Harness: the not-armed case; the roots; the secret door.
Phase 5, the readings: system dynamics, the reading, learnings applied, the rhythm ring, the instruments wired into the brief, the cadence and the gates. Harness: the brief order; the cadence stretch.
Phase 6, the mind and the stacks: the Davara view, voice, the second stack, the studio, MotusLive with the selection law. Harness: off-air emptiness; the refused studio.
Phase 7, the stranger: no baked secrets, no personal defaults, discovery by shape, the first-run card, `/help`, the fresh harness, the open-source gate with decoys. Harness: fresh CLEAN; gate zero.
Phase 8, the device: one-command build and install per platform, the continuous build, the Release. Harness: the workflow green on both runners.

## 6. The ship gate, every phase

1. `node --check` on every script.
2. The smoke run, and the report read, not the exit code.
3. The fresh run when a view or first-run behaviour changed.
4. The click test when a start path changed.
5. The open-source gate at zero blocking and zero warnings, with a decoy planted and caught for any new rule.
6. One screenshot per changed surface, at desktop and at 375 px, looked at before it is shown.
7. The report in the contract: TITLE, CONFIDENCE with BASIS, FALSIFIER, SHUTTLE, DID, FILES, NEXT.

## 7. What not to build

No telemetry, no phone-home by default, no reads outside the operator's roots. No dependency added for convenience. No feature that arms, spends or deploys without the operator's hand. No harness assertion silenced instead of fixed. No text sliced in JavaScript, no blur behind the canvas, no grey label, no sharp corner. No line of the founder's changed.

# END OF PROMPT

---

Motus Is The Mindset. The Mindset Means Move.
