# Open-source gate

CortexInsight was built paired to one machine and one operator. Before the tree went public, every item below had to be true. The check script covers the mechanical part; the rest is judgement.

## Run the check

```bash
node scripts/oss-check.js
```

It scans every text file that ships (source, docs, helper scripts, the lockfile, the `src`, `docs`, `scripts`, `assets` and `.github` trees) for secret shapes (API keys, tokens, private keys), the old baked credentials, and personal identifiers, and exits 1 on anything blocking. A clean run means none of those shapes were found. It does not mean the tree is safe; read the rest of this page.

## Resolved

1. **The baked password hash is gone.** A fresh vault has no password; the gate asks for one on first run (12+ characters, entered twice) and stores its SHA-256 in the vault. The operator can change it on Config → Access. Nothing in the code can open the gate.
2. **The baked hardware fingerprint is gone.** A fresh vault pairs itself to the first machine that opens it and stores that fingerprint; a copied vault keeps its pairing and does not re-pair. The check still refuses both old constants so they cannot come back.
3. **Personal defaults are gone.** The fleet root is discovered on first run. The WSL distribution, user and home are derived from the configured root. The project root is derived from where the build sits. The canary recipient and sender are empty. The ElevenLabs key sources come from settings plus two conventional paths. The helper scripts use their own location. The word "Initium" remains where it is product vocabulary.
4. **Backups are out of the tree.** Build outputs, `*.bak*`, dead root copies and staged installs are ignored by git and were moved out before the first commit.
5. **The tree is under version control** and was published from a clean working tree after the gate passed.

## Already true

- Secrets at rest use the OS keystore (Electron `safeStorage`, DPAPI on Windows): the ElevenLabs key, the OpenAI key and the SMTP app password are sealed on save and decrypted only in the main process. The renderer never receives ciphertext or plaintext; it receives `keySet` booleans.
- Every key is verified against its provider before it is sealed. A stored-but-dead key is refused.
- The renderer is sandboxed behind `contextIsolation` and a fixed preload bridge. There is no `nodeIntegration`.
- The Content Security Policy allows only self, Google Fonts, `data:` and local `file:` images (the studio), and `blob:`/`data:` media (voice).
- The vault (`cortex-insight-state.json`) lives in the user data directory, never in the tree.
- Agents can only append to a queue (`~/.cortexinsight/inbox.jsonl`); the app validates and applies every operation itself, with per-day caps on anything that spends.
- The broadcast payload is built only from ticked items, scrubbed twice, and empty when off.

6. **The private relay's name is gone and the gate blocks it.** The fleet tree is discovered by shape, never by name. The gate blocks the one-token name and any tunnel hostname, and was proven on a planted decoy. The public history was rewritten to a fresh commit after the scrub.
7. **The stranger's first hour is a harness.** `npm run fresh` starts from an empty vault with no fleet tree, sets a passphrase, pairs, walks every room, and fails on a blank room or a missing next step. Its report is `%TEMP%\ci-fresh-report.txt`.

## Still to prove

- **A first run on a foreign machine.** The fresh harness simulates it on the authors' machine. The real thing is a fresh clone on hardware the authors never touched, with the smoke and the fresh run read there.
- **A license.** The founder's call. Until a `LICENSE` file exists the tree is source-available.
- **The operator's name in prompts.** Agent prompts address the operator by the founder's name. A settings field and a mechanical pass over the prompt strings would let a fork name its own operator.

## What the app reads and writes

Read-only: the fleet tree (logs, checkpoints, transcripts, memory), the Davara baseline clone, the BuildMode canon. Written: its own vault and sidecars in user data, `~/.cortexinsight/` (fleet config, brief, agent tools, inbox, MotusModels), and the runner bridge block when the operator installs it.

## Before any public push

- Run the check; it must exit 0.
- Re-read the diff for names, paths and hosts that are personal.
- Push the private backup first, then the public tree.
