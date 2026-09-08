# Security

## What this app is

CortexInsight is a desktop operator console over a local agent fleet. It runs on one machine, reads that machine's own logs and transcripts, and drives agents through a loopback relay. It is not a service; nothing listens on a public port.

## Threat model

- **A copied vault.** The vault is paired to the machine that created it. On a foreign machine the app shows a decoy state and records the attempt. Secrets in the vault are sealed with the OS keystore and cannot be decrypted elsewhere.
- **A stolen key.** Provider keys (OpenAI, ElevenLabs, SMTP) are sealed on save and decrypted only in the main process for the request that needs them. They never reach the renderer, logs, notifications or error messages; provider errors are truncated and key shapes are masked.
- **An agent that misbehaves.** Agents cannot touch app state. They append to a queue that the app validates and applies with caps: tasks, notes, learnings, questions, delegations and image requests. Delegation defaults to propose-only. Nothing an agent writes can spend without an operator-set cap.
- **A prompt that carries instructions.** Text from transcripts, inboxes and web pages is data. The app never executes instructions found in observed content.
- **The machine itself.** Motus Max can move the pointer and type. It refuses protected windows (password managers, wallets, banking, sign-in and Windows security screens), refuses to type anything shaped like a credential, has no shell verb, and halts on a global panic key.

## Reporting

Report a vulnerability privately to August@Outlier.Systems. Say what you found, how to reproduce it, and what you think it exposes. Please do not open a public issue for anything that could leak a key or a vault.

## Before publishing a fork

Run `node scripts/oss-check.js` and read `OPEN-SOURCE.md`. The check refuses baked credentials, secret shapes, the private relay's one-token name and tunnel hostnames; the document lists what still has to move out of code. Prove the check on a planted decoy before trusting a clean run.
