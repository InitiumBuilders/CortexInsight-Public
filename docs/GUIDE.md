# The guide

Walkthroughs, in the order an operator meets them. Each one ends with what you should see, so you can tell whether it worked.

## 0. What you need

- Windows 10 or 11, Node 20 or newer, npm.
- A WSL2 distribution with a fleet tree: a folder in the home directory (any name) holding `logs/interactions/*.jsonl`, `agents/<name>/checkpoint.state`, `agents/<name>/memory/*.md`, and the runner scripts. The console reads these and never rewrites them.
- The loopback relay on `127.0.0.1:8788`: a proxy that turns each message into a `claude -p` turn on your Claude Code subscription. Check it with `curl http://127.0.0.1:8788/health`.
- Optional: a Davara baseline clone in the WSL home (the Davara view reads it), an OpenAI key (the second seat and the studio), an ElevenLabs key (voice), a Gmail app password (the canary email).

## 1. First run

Download a release zip and run `CortexInsight.exe`, or from a clone:

```powershell
powershell -ExecutionPolicy Bypass -File .\Build-And-Install.ps1
```

To run from source without packaging:

```bash
npm install
npm start
```

Either way `docs/INSTALL.md` has the details, the switches and the uninstall.

The gate opens in setup mode. Type a passphrase of twelve characters or more, twice. The vault stores its hash and pairs itself to this machine. The console then looks under every WSL home it can see for a folder holding `logs/interactions` and `agents`, and uses the one whose interactions moved most recently.

You should see: Pulse, with the reading at the top. If the relay is down, the titlebar says so and Command waits. If no tree was found, Config → Preferences has the path field.

Sync helper: `Sync-And-Launch.ps1` at the root checks the relay, starts it through WSL if it is down, checks the tree, and launches the packaged exe if one exists or `npm start` if not.

## 2. Your first turn

Open Command. Type `/help` first: it lists every command and the agent tool, and links these pages, without spending a turn. Then type a sentence and send it to Davara (or whichever seat is the default). The reply arrives with its latency. Try `/reading` to get the one-sentence read, and `/leverage what should move first?` for the strategic read with a lever, a rung, a first step and a divergent frame. Ctrl+K opens the palette; type `guide` there to open this page from inside the app.

You should see: the reply in the thread, a provenance stamp on the sent log (Secure view), and a receipt on Pulse.

## 3. Install the bridge

Open Model. The bridge panel says whether the runner carries the guarded block. Click Install. The console writes `~/.cortexinsight/fleet.json`, adds one block to the runner after the tools line with a timestamped backup, runs `bash -n`, and rolls back if that fails.

From now on every turn reads the per-seat model, effort and turn budget fresh, and the brief is prepended to every message. Change a seat's effort on Agents and the next turn uses it. No relay restart, ever.

You should see: "bridge installed, carries the brief" on Model, and the effective model per seat on Agents.

## 4. Teach an agent to talk back

Send this once to an agent: "Read `~/.cortexinsight/README-FOR-AGENTS.md` and remember it." The manual is rewritten on every boot, so it is always current.

The agent now has a tool:

```bash
bash ~/.cortexinsight/ci.sh task "Title" "detail" high
bash ~/.cortexinsight/ci.sh doing <id>
bash ~/.cortexinsight/ci.sh done <id> "what happened"
bash ~/.cortexinsight/ci.sh claim <id>
bash ~/.cortexinsight/ci.sh ask "a question for the operator"
bash ~/.cortexinsight/ci.sh hand <agent> "Title" "detail"
bash ~/.cortexinsight/ci.sh learn "a durable lesson"
bash ~/.cortexinsight/ci.sh note "a note"
bash ~/.cortexinsight/ci.sh image "a prompt for the studio"
```

Each call appends one line to a queue. The console applies it under your caps: delegation is propose-only at the default cap of zero, images count against a per-day cap, and a `done` is corroborated against the transcript before it is trusted.

You should see: the task on the Board tagged with the agent's name, and a question as a waiting priority-1 task assigned to the asker, with a Run button that sends your answer straight back.

## 5. A day on the board

- Add a task with the grammar in the title: `!! Fix the gate copy @davaris #console`. Two marks is high priority, `@` assigns, `#` tags. Add ` ~park` to park it.
- Watch the WIP strip. Above the limit it says so. The flow line shows what entered and what left today.
- Click a card to open its whole body; nothing is cut off.
- When the sweep band appears, it lists work older than three weeks with no movement. Park it or close it; a parked task is never scheduled.
- Assign a task to an agent and click Run, or leave it assigned and let auto-work take it when the governor allows.
- At the end of the day, THE CLOSE proposes what the transcripts say was finished. One click closes each with a receipt.
- The NEXT tray holds the follow-ups loops and drives proposed. One click makes one a task.

You should see: the flow line moving, the WIP count honest, and closes with receipts on Pulse.

## 6. Arm a loop

Open Duo-Drive. The Loops tab lists the seeds. Most are off. Turn on Polish Pass, set its cadence, and set Duo-Drive active with a seat.

Every pass: the loop reads the creed, the systems sight, its organs, your design ethos and the reading, then works within the guardrails and reports in the contract shape. The Work log shows each pass with its verdict (shipped, reported, skipped), its confidence, and a quality chip. A pass below the loop's confidence floor is skipped and says why.

Register a project on the Projects tab (name, URL, local folder, repo, ethos). Loops touch only listed, enabled projects.

To let her design a loop: click Invent. It arrives unapproved and disabled in the gold panel. Approve, revise or reject.

You should see: passes in the log with quality chips, and a stretched cadence on any loop that keeps skipping or scoring low.

## 7. Build a workflow with a gate

Open Workflows. Start from the Adversarial review seed or make a new one: two to twelve stages, each with a seat and an instruction. Mark a review stage as a gate. Run it with a seed sentence. The confirm shows the estimate beside your position in the five-hour window.

A gate stage must answer `VERDICT: PASS|BLOCK`. A BLOCK halts the run and files a priority-1 task with the reason. A PASS at confidence under 5 is a block too. If a run fails midway, Resume restarts after the last successful stage with its real output.

To arm a trigger: choose fault, task or duo, an optional match, and a cooldown. One workflow fires per event.

You should see: the run history with a confidence chip per stage, and a board task if a gate blocked.

## 8. Arm Motus Max

Open Motus Max. Set the scope (guarded is the default: only the allow-listed windows), the pacing (auto, or ask before each batch), the time to live, and the step budget. Hold the arm switch. Only your hand can do this.

The moment you arm, the pre-read runs: the strip shows READING, then READY with a lever and a first step. Click Drive, or type `/motusmax` on Command with or without a goal. Without a goal she drives the chosen lever.

While she drives: the HUD shows the state over every display, the Live view streams the cycles, and the strip shows the seat clock. Speak to steer if DASH-OPS is on. Press the panic key to halt.

Modes: auto reads the goal; work always uses files, commands and APIs; screen always drives the pointer. Most real work is work mode. Continuous mode chains the next move after each done, up to the chain limit.

You should see: an audit line per cycle on the view, a work-ledger entry per move, and a lesson banked at the end of the drive.

## 9. Voice

Open DASH-OPS. If the machine already holds an ElevenLabs key in a conventional spot (`~/.config/elevenlabs.env` or a path you list under `elevenKeySources` in Settings), the console adopts it and proves it against the API. Otherwise paste one. A key that does not answer is refused.

Pick a voice from your own library, and a model: Flash for the fastest first word. Call mode listens and speaks in turns; push-to-talk holds a key. Your speech is recognised locally; only the reply text goes out. Say "the reading", "what's on the board", "is she armed", "how long have we been at it", or "go to" any room by name, and the app answers by itself with no turn spent. The strip meters every turn; if three answers in a row are slow, quick mode turns itself on and tells you.

You should see: the orb changing state, and "voice ready" in the strip.

## 10. The second stack and the studio

Open Config → Integrations → OpenAI. Paste a key. The console verifies it against the models list and seals it. Pick the seat model from the list your key can see.

Now `/gpt hello` on Command answers from the GPT seat on its own lane. `/image a lantern in fog` makes an image that lands on Output. Agents can ask for images with `ci.sh image`. Set the per-day image cap in the same panel.

You should see: the GPT seat on Agents, and the studio band on Output with the image.

## 11. Go on air

Open MotusLive. Set the host (the page that will show the broadcast; `semble.cc/live` is the reference surface). Choose a persona and a topic. Tick the items to show. Nothing is ticked by default.

Push. Verify compares the page with what was sent. Enforce corrects the page. The drift watch alarms when they diverge.

Turn it off and the page shows off air, because the payload carries nothing else. The law is the founder's: "nothing ever private or security stuff. Only the stuff I select."

You should see: the verify line green, and an empty payload when off.

## 11a. Name the Motus and watch the well

Open Motus. Write the single strongest thing you are moving on and press Set. The well draws the board around it: work that shares its words orbits close, work that shares none drifts on the outer ring. The evidence strip counts what the Motus earns from now on: turns, closes, passes shipped by the loops, learnings. Press "Sharpen with Davara" for one line and one falsifier; use the line or keep yours. From now on a task that drifts for a week is proposed on THE CLOSE, and every agent's brief says how many open tasks share no words with the Motus. Open Goal for the ladder: star, push, today's turns, learning.

## 12. Read the Davara view, then press it

Open Davara. The strip shows the baseline version. The stack ladder shows every layer with its trust and whether it is mutable at runtime. The organs panel shows what each loop kind invokes. The stream shows recent evolutions. The covenant card runs one ceremony on click. Press a command and it is typed for you on Command; press a protocol and its invocation is typed. Her console asks her through one chosen protocol: write the subject, choose the protocol, press Ask, and the reply lands under the reader. Nothing spends a turn until you press the button that says so.

If no baseline clone exists on the machine, the view says so. The loops run without the organs, which is allowed and weaker.

## 13. The reading and the rhythm

Pulse shows the reading and the ring: turns over the last day, today's window and the peak window. The stocks and flows under it name what is filling and what is draining. The attractor line says which loop the work is falling toward.

The same sentence is in the brief every agent reads, in every loop prompt, and in the strategic read. Change what the fleet does and the sentence changes; that is the loop closing.

## 14. Update, test, gate

```bash
npm run package     # a portable build in release-next\
npm run smoke       # every view, sandbox vault, report in %TEMP%\ci-smoke-report.txt
npm run clicktest   # timings behind the start buttons, report in %TEMP%\ci-click-report.txt
npm run fresh       # the stranger's first hour: empty vault, setup gate, every room, report in %TEMP%\ci-fresh-report.txt
npm run gate        # secret shapes, private names, personal defaults
```

The fresh run is the one to read before you hand the console to someone else. It starts from nothing, sets a passphrase the way a new operator would, opens every room with no fleet tree behind it, and records what each room says when there is nothing to show.

A running app that finds a newer build staged in `release-next` offers to swap itself. `Update-MotusMax.ps1` does the same by hand and proves the version it landed on.

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| "relay offline" in the titlebar | the loopback proxy is not listening | `wsl -e systemctl --user start cortex-mouth-proxy.service`, or run the sync helper |
| "could not reach the fleet on this network" at the gate | the vault is not paired to this machine | this is the foreign-device state; on your own machine, delete the vault to re-pair |
| The Davara view is empty | no baseline clone in the WSL home | clone one, or accept loops without organs |
| Voice says the key was refused | the key did not answer `/v1/voices` | it may be a key id rather than a key; keys start with `sk_` |
| Motus Max will not start | it is not armed, or the time to live expired | hold the arm switch again |
| A loop keeps skipping | its confidence floor is above what the passes reach | lower the floor or sharpen the instruction; the cadence stretches on its own |
| Hard stop banner is amber | the bridge is not installed, so the runner cannot refuse turns | install the bridge on Model |
| Smoke exits 0 but something looks wrong | exit codes are not proof | read `%TEMP%\ci-smoke-report.txt` and the screenshots |
