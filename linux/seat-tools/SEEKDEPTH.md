# SEEKDEPTH — the fourth gear

Built 2026-09-20 on the operator's word. Leaves the Claude subscription
entirely and answers on **OpenRouter · `deepseek/deepseek-v4-pro`**
(served by `deepseek/deepseek-v4-pro-0813`, 1,048,576-token window).

## Saying it

| he says | gear |
|---|---|
| "Activate SeekDepth Mode", "SeekDepth Mode", "seek depth mode", `/motus seekdepth` | **seekdepth** |
| "SeekDepth Off", "SeekDepth Mode Off", "turn off seekdepth", "Main Mode" | **cruise** (Opus 5) |

OFF is matched before ON, because "seekdepth mode off" contains "seekdepth mode".
Ordinary prose does not move the lever — "can you seek out the depth of this"
and "the main modes of failure" both resolve to nothing. 19 phrases under test
in `audit/seekdepth-triggers.py`, which reads the rules out of the live relay
source rather than restating them.

**SEEKDEPTH does not cool down.** Every other gear expires after ~2 h; this one
has `until: null` and holds until he says otherwise.

From the shell: `bash motus-mode.sh august seekdepth` / `... august clear`.

## How it routes

`cortex-run.sh` treats any model id carrying a vendor prefix (`~deepseek/...`)
as an OpenRouter id — Anthropic's are bare (`claude-opus-5`). For those, and
only those, it exports `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. Claude
Code itself speaks to OpenRouter, so **every tool, the MCP bridge and session
resume keep working**.

Three things that cost real time and are worth never rediscovering:

1. **`ANTHROPIC_BASE_URL` must be the ROOT, `https://openrouter.ai/api`** —
   Claude Code appends `/v1/messages` itself. With `.../api/v1` it posts to
   `/api/v1/v1/messages`, gets a 404, and reports *"the model may not exist or
   you may not have access to it"* — which sends you hunting the model id
   instead of the URL.
2. **The runner's model validator rejected `~` and `/`.** `re.fullmatch(r"[A-Za-z0-9._\[\]-]{1,64}")`
   silently blanked the model and the gear fell back to the default, doing
   nothing at all, with no error anywhere.
3. **Claude Code refuses a model its catalogue does not know.** The fix is a
   `modelPicker.options` row in `~/.claude/settings.json` with `behavesAs`
   naming a model it does know. Schema read out of the CLI bundle, not guessed.

`--effort` is an Anthropic flag; the OpenRouter branch clears `CI_EFFORT` and
`unset -f claude` so the wrapper cannot append it.

## Safety

- `ANTHROPIC_API_KEY` is still never set. Unchanged, gated.
- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are **unset at the top of every
  turn** and re-exported only when this turn's model is vendor-prefixed. A
  leftover from a SEEKDEPTH turn cannot send an Opus turn to a third party.
- The key lives at `/root/.openclaw/credentials/openrouter-api-key.txt`, 0600,
  and travels as an environment variable — `/proc/<pid>/cmdline` is
  world-readable on this box, `/proc/<pid>/environ` is owner-only.
- If the key file is missing the turn **degrades to Opus 5 and logs it**; it
  does not die and it does not call out silently.

## Cost

SEEKDEPTH spends OpenRouter credit, not the Claude subscription. A one-word
round trip measured $0.00018.

## Instruments

`gates.seekdepth` — 15 falsifiers, **15/15**, record in `.gates/`.
Last: `seekdepth-20260920T100933Z.txt`.
