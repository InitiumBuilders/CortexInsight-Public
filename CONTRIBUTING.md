# Contributing

CortexInsight accepts proposals, fixes and features. The bar is high on purpose and the rules are short. Read this page once; the gate enforces most of it.

## Run it

```bash
npm install
npm start           # from source
npm run smoke       # every view in a sandbox vault; read %TEMP%\ci-smoke-report.txt
npm run clicktest   # timings behind the start buttons
npm run fresh       # the stranger's first hour: empty vault, no fleet tree, every room; read %TEMP%\ci-fresh-report.txt
npm run gate        # secret shapes, private names, personal defaults; must exit 0
npm run package     # a portable build in release-next\
```

`node --check main.js` before running anything. Parsing is not loading, so run the smoke too.

Every push to `main` and every pull request runs the gate on Linux and then, on a Windows runner nobody here has touched, the fresh-vault harness and the packager (`.github/workflows/build.yml`). The fresh run's report and screenshots are uploaded as artifacts; read them when a run goes red. A `v*` tag turns the zip into a Release.

## The laws

These are the rules the code already keeps. A change that breaks one is not a change we can take, however good the feature.

**Trust**
- The fleet's files are read, never rewritten. The only writes into the fleet tree are the guarded bridge block and the two confirmed, backed-up levers.
- Agents append to a queue; the app validates and applies under operator caps. No new inbox verb may spend without a cap.
- Only the operator's hand arms Motus Max. No command, agent, trigger or voice path may arm it.
- Keys are verified against their provider and sealed with the OS keystore. The renderer never receives a key, a ciphertext, or a passphrase hash; it receives booleans.
- Nothing phones home unless the operator turned a service on, and off means the payload carries nothing.

**Honesty**
- Loop passes and workflow stages report in the contract: TITLE, CONFIDENCE with BASIS, FALSIFIER with a clock, SHUTTLE, DID, FILES, NEXT. A new prompt path keeps the contract.
- A claim of done is corroborated, never taken on its word. Negation is read by adjacency, never by presence.
- Any instrument you add must feed an actor (a prompt, a priority, a cadence, a seat choice, a gate) and prove the wiring with a fixture in the smoke.
- A harness that exits 0 without writing its artefact is a broken harness. Read the report.

**Performance**
- No synchronous file work behind a click. Anything touching the WSL bridge is async, single-flighted, stale-while-revalidate, and returns the in-flight promise while a refresh runs.
- Read the growth: delta reads with a carry, the frozen index for the past, stat-gated caches for the rest. A size-plus-mtime cache never hits on a live log.
- One canvas, capped, stopped when hidden. No blur filter behind it. Animate transform, opacity, shadow, filter and stroke only, and only what is on screen.
- Render when the data changed. Poll at seven seconds.

**Design**
- Text is never sliced in JavaScript. Render it whole, clamp in CSS, open on click.
- Nothing sharp-cornered. No grey or low-contrast text; hierarchy comes from size and weight. Glow, never highlight. No box or ring on icons and buttons.
- Symmetry: strips of five or four, never a three-plus-two orphan. Verify at 375 px; the smoke takes a mobile pass.
- Every view carries its own hue through `--view-hue`. Do not hard-code a colour where the hue system reaches.
- Motion is transform and opacity with springs, never a linear fade of a box. Nothing animates while the window is hidden.

**Words**
- The founder's lines in the About panel and the taglines are verbatim and stay that way.
- Copy you write is plain: no staging, no one-line closers, no dashes as connectors, no inflated significance. Say the fact.

## Where things go

`main.js` is one file in organ order (see `docs/ARCHITECTURE.md`). Put a new reader with the readers, a new inbox verb with the inbox, a new view's IPC handlers beside the others in the handler block, and a new smoke assertion in `runSmoke` with a `[TAG]`. New views: an entry in `NAV` in `src/renderer.js`, a section in `src/index.html`, a `load<View>()` in `src/renderer-v2.js`, styles in `src/styles-v2.css`, and a smoke visit. New settings: a default with a comment in `defaultState()`, and a strip in `safeSettings()` if it is sensitive.

## Propose a feature

Open an issue with the feature proposal template. It asks for what you observed, what reading would measure it, which actor consumes the reading, what would prove the feature wrong, and what it costs in tokens or time. A proposal with those five answers gets read the same day it lands. A proposal without them is a wish, and we will ask for the answers before discussing it.

Big changes (a new lane, a new service, anything touching the guard, the bridge, the inbox or Motus Max) start as a proposal before code. Small fixes can go straight to a pull request.

## Send a pull request

1. One change per pull request. Name the deletion alternative first: what could be removed instead of added.
2. `node --check`, the smoke, the click test when you touched a start path, the gate. Paste the relevant report lines.
3. A screenshot for anything visual, at desktop and at 375 px, looked at before it is attached.
4. Fill the pull request template. It is the loop contract.
5. Commit messages: a short line saying what changed and why, no trailing summary, no dashes as connectors.

## What we will not merge

- Anything that phones home by default, adds telemetry, or reads outside the operator's roots.
- A dependency added for convenience. The renderer has no framework and the main process has one dependency. Argue for a new one in the proposal.
- A feature that arms, spends, or deploys without the operator's hand.
- A change that silences a harness assertion instead of fixing what it caught.
- Text sliced in JavaScript, a blur filter behind the canvas, a grey label, a sharp corner.

## Reporting a vulnerability

Privately, to the address in `SECURITY.md`. Never in a public issue.
