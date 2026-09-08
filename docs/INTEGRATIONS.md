# Integrations

CortexInsight runs on two stacks and speaks to a handful of services. This page says what each connection is, where its key lives, what leaves the machine, and how to wire it.

## The Anthropic stack (the fleet)

Davara, Davaris, Davari, Sympath-Cortex, Arden and the generic seats run through the fleet relay: a loopback proxy on `127.0.0.1:8788` that turns each message into a `claude -p` turn on the operator's Claude Code subscription. There is no API key; the subscription is the credential, and it never touches this app.

- Set the fleet path on Config → Preferences (the WSL tree the relay lives in). On first run the app discovers it.
- Install the fleet bridge on Model so per-seat model and effort reach the runner, and the brief reaches every turn.
- What leaves the machine: the prompt, to Anthropic, through Claude Code. The app never calls Anthropic directly.

## The OpenAI stack (the second seat and the studio)

Config → Integrations → OpenAI.

- Paste an API key from platform.openai.com. The app verifies it against `/v1/models` before sealing it with the OS keystore. A key that does not answer is refused.
- Pick the seat model from the list your key can see; the app proposes a default and never invents an id.
- The GPT seat joins the fleet on lane `openai`. Reach it from Command with `/gpt <text>`. It carries the fleet's standing brief and no soul file.
- The studio makes images for the whole fleet with your key: `/image <prompt>` on Command, the Generate box on Output, or an agent's `bash ~/.cortexinsight/ci.sh image "<prompt>"`. The app spends, under the per-day cap you set. Images land in the user data `studio` folder and on Output.
- Text bound for OpenAI passes the same secret-shape guard as the keyboard; anything that looks like a credential is refused before it leaves.
- What leaves the machine: the turn's text or the image prompt, to `api.openai.com` over TLS.
- Sign-in with a ChatGPT account is not wired. OpenAI's consumer login has no public app flow this app could use without impersonating a browser, so the API key is the supported door. If OpenAI publishes a device or OAuth flow for desktop apps, it slots in behind the same panel.

## Both stacks at once

They already run together. Seats route by lane: relay seats through Claude Code, the GPT seat through OpenAI. The board, the loops and the workflows do not care which stack answered; receipts carry the seat's name.

## ElevenLabs (voice)

DASH-OPS. Paste a key, or let the app adopt one from the machine: it looks under the WSL home at the paths you list in Settings (`elevenKeySources`, for example a project's `.env.local`), then at `.config/elevenlabs.env` and `.config/motus/elevenlabs.env`. Every candidate is shape-checked (a real key starts with `sk_`) and proven against `/v1/voices` before it is sealed. A value that does not answer is refused with the provider's reason. Only the agent's reply text goes to ElevenLabs; your speech is recognised locally in the renderer.

## OpenRouter (Sympath SEI)

Sympath SEI runs in her own gateway with her own key. This app observes her and never relays to her.

## Email (the canary)

Config → Alert email. A Gmail app password, sealed on save, used only to send the foreign-device canary. The recipient and the sender are empty by default; set both.

## MotusLive and semble.cc (the broadcast)

The MotusLive view pushes selected work to a public page. The reference surface is `https://semble.cc/live`; the host is a setting, so a fork can point at its own page.

- The write credential lives in `~/.cortexinsight/live-secret`, never in the vault and never in the tree.
- Nothing is selected by default. Only ticked items enter the payload. Every string passes the secret gate and anything flagged is dropped and counted. The server re-scrubs on arrival.
- Off means absent: when the broadcast is off the payload carries `on:false` and nothing else.
- Verify compares the page to what was sent. Enforce corrects it. The drift watch alarms on divergence.
- The persona pantheon in the app mirrors the site's; ids must stay in lockstep so the page can retune to the chosen persona.
- The founder's law, verbatim: "nothing ever private or security stuff. Only the stuff I select."

## The Davara baseline

The Davara view and the loop organs read a baseline clone from the WSL home (`DAVARA-DV2-BASELINE`). Nothing is written there. Without a clone the view says so and the loops run without organs.

## Where keys live

Sealed with Electron `safeStorage` (DPAPI on Windows) inside the vault in the user data directory. The renderer never sees them; it sees `keySet` flags. Clearing a key deletes the ciphertext.
