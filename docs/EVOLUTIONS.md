# Evolutions

The console grew by being used. Every version below was a response to something the operator saw, said, or could not see. The lesson beside each one is what the code learned; most of them are now laws in `CONTRIBUTING.md`.

Dates are 2026.

## Era one: the mirror (June)

**1.0.** A hardware-locked window into the fleet: every task ever run, who is doing what now, usage and timing, a command channel with steer and goal, a security panel proving every command came from this machine. Read-only on the fleet from the first day.

**1.1.** The Sentinel (tray icon carrying the fleet's pulse, a watchdog, an integrity monitor over the critical files), Live (the transcript streamed read-only), and the closed loop (measured proposals with apply and a before-and-after experiment).

**1.2.** NOW cards, because the interactions log only lands when a turn completes and in-flight work was invisible. Output. The screen flash removed: every panel renders only when its data changed. Rituals. The command palette. The Systems Lens.
*Lesson: read the live source, never the summary of it.*

**1.3.** Caps, clears, memoised parsers, and every handler wrapped so a thrown error becomes a result rather than a crash.

**1.4 to 1.5.** Two more seats (the healer and the observer), the decoy IP, the canary and its email, and the discretion principle: a real security layer never announces itself.

**1.6 to 1.6.1.** The two focuses, Motus and Goal. Then the bug that wiped them: a second instance clobbering the vault. Single-instance lock, atomic saves, a backup to fall back on.
*Lesson: two writers and one file is a data-loss machine.*

## Era two: the nervous system (late July to early August)

**2.0.** The fleet registry as the single source of truth. The bridge: one guarded block in the runner that reads per-seat config fresh every turn, so a model change never needs a restart. Subagents made visible. The control plane with soft and hard stop. Duo-Drive. Real token metering. The board, workflows and a rebuilt Systems view.

**2.1.** The slowdown found: a full-screen canvas animating behind twenty blurred panels made the compositor re-blur everything on every frame, machine-wide. The canvas capped and stopped when hidden, the blur removed. The agent inbox: `ci.sh`, the tool that lets an agent add to the board from anywhere.
*Lesson: canvas plus glass re-blur is drag. Check it first on any slow UI.*

**2.2.** The idle-pass leak closed: a cadence pass with nothing changed now costs nothing. The brief, so every turn starts oriented. Learnings that recur are reinforced rather than dropped. Experiments that conclude and revert what measured worse.
*Lesson: a repeat is the strongest signal a ledger makes.*

**2.3 to 2.5.** The budget governor. Workflow gates, resume and estimates. `ask`, `claim`, `hand`. Triggers. Verified done, corroborated against the transcript. Self-triage: a finding that persists becomes a task that closes itself. Presence-gated notifications.
*Lesson: a reviewer saying "do not ship" must be an outcome the machine respects.*

**2.6.** Nothing cut off. The truncation was slicing text in JavaScript before rendering; the fix is to render everything and clamp in CSS, with a click to open.
*Lesson: presentation clamps, data never does.*

## Era three: the loops (early August)

**3.0.** Duo-Drive became leverage loops: a loop is the primitive, with a kind, an instruction, a confidence floor and a project scope. She can author a loop and can never arm it. Guardrails carried verbatim in every pass. A completed-work ledger with a verdict per pass.

**3.1 to 3.2.1.** DASH-OPS voice, with speech recognised locally and only the reply text sent out. The artifact loop kind. The ElevenLabs key adopted from the machine, then the correction: the value adopted was a key id, not a key, and it looked exactly like one.
*Lesson: a credential is not adopted until it has answered the real API.*

## Era four: the hands (August 9 to 16)

**3.3 to 3.4.** Voice input made to work outside the Web Speech API. The WSL bridge outage and the Action Protocol.

**3.5.** Motus Max: the founder granted the OS-level control the console had refused to build silently. The MotusModels studio.

**3.6.x to 3.7.** She did nothing, and the reasons were found in evidence: a UTF-8 byte-order mark on a result file, Windows clamping a non-resizable window to one monitor, and the wrong display being photographed. Then she refused, and her own audit log showed she was right to.

**3.8 to 3.9.** Past the screenshot era: instruments before eyes. She read a file, called an API, ran a command, and made a real move. Then she chained three, all her own.
*Lesson: the perceive, decide, act loop is right for a GUI and wrong for most work.*

**3.10 to 3.16.** Seat capability measured from the runner rather than declared. The adaptive interface engine. The permission wall found to be imaginary. Always a move; voice steering; the panic key actually bound. The show law: she was working and the operator could not see it, so `[[OS:show]]` exists. The app updates itself.

**3.26 to 3.27.** The silent self-update bug: a swap that failed and relaunched anyway, indistinguishable from success, with a removal that would have deleted the only copy of the new build. Rewritten to poll, retry, verify, roll back. Then Motus Max made visible.
*Lesson: a tool that succeeds silently has failed at half its job.*

## Era five: the show and the stream (August 18 to 20)

**3.28 to 3.32.** Completed work with dates, projects and URLs. The flow: the rail as six phases with arrival choreography. Every view its own light. The MotusLive desk, session replay, THE MOVE.

**3.34 to 3.37.** The broadcast host became a setting. Off-air became real absence: the payload carries nothing when off, because a flag was doing security work only absence can do. The app finds its own back end. The off-air sweep. The drift watch. R3 made measurable.
*Lesson: off means the data is not there.*

**3.38 to 3.46.** The alarm proven in anger. The view sigil that breathes what its room reports. The app measures itself, the vault keeps itself, the whole-system read. Pulse became the dashboard with the engine room and today's receipts. The ledger cache. DASH-OPS rebuilt and made ambient. 375 px looked at. The shared picture, the intention loop, the living rail. The prompt witness and the finishing grammar.

**3.48 to 3.51.** The real lag found. Three root causes for the empty tabs, the dead panic key and the stuck drive, all found in evidence. The blank-tabs bug reproduced and killed. The Motus Max speed pass calibrated to the measured relay.
*Lesson: reproduce live before reading statically.*

## Era six: the rhythm and the mind (September 7)

**3.52.** The click spike measured and removed: the synchronous work behind a start button went from about four seconds to about a hundred milliseconds, and boot parsing from five and a half seconds to about a hundred milliseconds, by reading the growth (delta reads with a carry) and freezing the past on disk. The seat clock. A harness for clicks.
*Lesson: a size-plus-mtime cache never hits on a live log.*

**3.53.** The rhythm: system dynamics with a ring, stocks, flows, delays, loops and the attractor. The pre-read, so the wait moves before the click. The poll tick trimmed. Nothing cut off, again, in the new surfaces.

**3.54.** The board as a flow: WIP limit, sweep, the close, the NEXT tray, task grammar. Adaptive cadence. Learnings that were applied, counted by their presence in closed work.

**3.55.** Davara's organs in every pass. The critic in the contract: confidence with a basis, a falsifier with a clock, the shuttle. The About panel with the founder's lines. Neoglass without blur.

**3.56.** The Davara view. The second stack on an OpenAI key. The studio for every agent. The open-source gate.

**3.57 to 3.59.** No baked secrets: first-run passphrase setup, a vault that pairs itself, a root that discovers itself, machine identity derived from the configured tree. The reading in the brief. The workflow critic. Trust on the stack ladder. The close. Her abilities. The light eases between rooms.

**3.60.** The instruments feed the actors: the reading rides first in the brief and in every prompt, quality feeds the scheduler and the seat choice, confidence governs pacing and gates, and the secret guard stands at the OpenAI door too.
*Lesson: a gauge only the operator reads is half built.*

**3.61.** The last personal defaults removed (project root derived from the build, WSL home from the configured tree, key sources from settings), the helper scripts made ASCII-safe for Windows PowerShell 5.1, the gate widened to every root file, the About panel linking the source and the live surface, and the first documentation set. Published to the Semble-CC repository.

**3.62.** The private relay's one-token name had shipped in the first public commits, against a standing rule the gate did not yet hold. Scrubbed everywhere (the fleet tree is discovered by shape, any home folder with `logs/interactions` and `agents`, newest first), the gate made to block that name and any tunnel hostname, the rule proven on a planted decoy, and the public history rewritten to a fresh commit. The stranger's first hour became a harness: `npm run fresh` starts from an empty vault with no fleet tree, sets a passphrase the way a new operator would, walks all twenty-six rooms, and fails on any that throws, stays blank, or leaves the operator without a next step. Its first run found one: Pulse called the relay broken and never mentioned the path. A first-run card now ranks first. `/help` on Command, doc links in the palette and on About, and this documentation set grown by an index with maps, a glossary, a pitch, and the first hour as a story.
*Lesson: a gate holds only the shapes someone taught it. Teach it every standing rule, then plant a decoy to prove it listens.*

## What the arc says

Three loops turned through these versions. The build loop: attention became shipped surface. The canon loop: every build became a lesson, and the lesson became a law in the code or in these pages. The mover loop: the console became something a second operator could run without the first one in the room. The third loop is the youngest and the one this release is for.
