---
name: pantheon-model
description: >-
  Configures WHICH AI model runs the adversarial step in pantheon-custom / pantheon-gap-custom — the
  OpenClaw-style "pick your model" setup, as its own command. It lists the models actually available on
  this machine (Claude tiers, GPT-5.5 via Codex, local Ollama/LM Studio models, and the cloud catalog
  in providers.json — DeepSeek, Qwen, Gemini, Mistral, Groq, xAI/Grok, Kimi, …), lets the user pick one
  (OpenClaw-style `provider/model-id`), securely sets up the API key in a file (never in chat) when a
  cloud model needs one, and saves the choice to ~/.pantheon/config.json so the custom skills use it
  without asking again. Use when the user says "pantheon model", "pantheon-model", "pick/choose the
  pantheon verifier model", "change the pantheon model", "configure pantheon custom", "팬테온 모델
  설정", "모델 고르기/다시 고를래", "채점 모델 바꿔". This skill only CONFIGURES; to actually run a job
  use pantheon-custom (generate) or pantheon-gap-custom (review).
---

# Pantheon model picker (OpenClaw-style setup for the `*-custom` skills)

OpenClaw selects its model in a standalone onboarding before you talk to it. This is the Claude-skill
equivalent: a dedicated command that **picks + configures the adversarial-verify model** used by
`pantheon-custom` and `pantheon-gap-custom`, and saves it to `~/.pantheon/config.json`. Those skills
then read that config and never re-ask. (`pantheon` / `pantheon-x` / `pantheon-gap` / `pantheon-gap-x`
are fixed-model presets and ignore this — it only drives the `*-custom` pair.)

It does **two** things: choose the model, and (for cloud models) set up the API key safely. It does
**not** run a harness — that's `pantheon-custom` / `pantheon-gap-custom`.

## Procedure (when this skill triggers)
1. **Show current state.** Read `~/.pantheon/config.json`; if it exists, tell the user the current
   `verifier`. If they only wanted to see it, stop. If they want to change/clear it, continue.
2. **Detect what's actually available on this machine** (so the menu only offers real options):
   - **Claude tiers** (always, no setup): `anthropic/opus`, `anthropic/sonnet`, `anthropic/haiku`.
   - **`codex`** (GPT-5.5) — include if the `codex:codex-rescue` agent type / Codex plugin is installed.
   - **Local** — run `ollama list` (and check LM Studio); list `ollama/<model>` for each pulled model
     (no key needed).
   - **Cloud** — read **`providers.json`** in this skill's directory (the catalog mirrored from
     OpenClaw). For each provider, mark it **ready** if its `envKey` env var is already set (`printenv`),
     else **(needs `<ENVKEY>`)**.
3. **Show the FULL catalog as a numbered list — every option visible from the start** (do NOT hide most
   of them behind a 4-option picker; the user wants to see the whole list). Two groups:
   - **Ready now (no key):** the Claude tiers (`anthropic/haiku|sonnet|opus`), `codex` (if the Codex
     plugin is installed), and each local `ollama/<model>` from `ollama list`.
   - **Cloud (needs a key):** **every** provider in `providers.json` (~27), each tagged **ready** if its
     `envKey` is set, else **(needs `<ENVKEY>`)**.
   Number them all sequentially, tag the current setting "(current)", and let the user pick a number, a
   `provider/model-id`, or an alias. (AskUserQuestion caps at 4 options, so it's not used here — the full
   list is shown as text.)
4. **If the pick is a cloud provider, set up its API key — in a FILE, never in chat:**
   1. Find its `envKey` in `providers.json`. Check `printenv <ENVKEY>` and `~/.pantheon/env`. If already
      set, skip to step 5.
   2. Create the secrets file: `mkdir -p ~/.pantheon && touch ~/.pantheon/env && chmod 600 ~/.pantheon/env`;
      append `export <ENVKEY>=` if that line isn't there.
   3. **Open it for the user** (`open -t ~/.pantheon/env` on macOS, else give the path) and ask them to
      paste their key after the `=` **in that file**, save, and say "done". **Never ask for or accept the
      key in the chat** — it would be logged / sent to the server.
   4. Verify without printing it: `set -a; . ~/.pantheon/env; set +a; [ -n "$<ENVKEY>" ] && echo OK`.
      If still empty, tell them and let them retry or pick another model.
5. **Save the choice.** Write `~/.pantheon/config.json`:
   ```json
   { "verifier": "<the chosen provider/model-id>" }
   ```
   For a **cloud** provider, also embed the routing block so the `*-custom` skills are self-contained
   (no need to re-read providers.json at run time):
   ```json
   { "verifier": "deepseek/deepseek-chat",
     "providers": { "deepseek": { "baseUrl": "https://api.deepseek.com", "envKey": "DEEPSEEK_API_KEY", "wire": "chat" } } }
   ```
   (Claude / `codex` / local picks need only `verifier`.) Never put the API key itself in this file —
   keys live in `~/.pantheon/env`. `config.json` holds only the model id (shareable).
6. **Confirm.** Tell the user it's saved, what the next run will use, and that `/pantheon-custom`
   (generate) and `/pantheon-gap-custom` (review) will now use it without asking. To change later: run
   `/pantheon-model` again; to clear: delete `~/.pantheon/config.json`.

## Notes
- **Config, not a run.** This sets the model only; it spends ~no tokens. Running the harness is
  `pantheon-custom` / `pantheon-gap-custom`.
- **Keys never touch the chat.** Cloud keys go into `~/.pantheon/env` (chmod 600); only the model id is
  saved in `~/.pantheon/config.json`.
- **One shared default** for both `*-custom` skills. A run can still override for that one invocation by
  naming a model inline (e.g. "verify with haiku").
- Add a provider not in the catalog by editing `providers.json` (any OpenAI-compatible endpoint:
  `baseUrl` + `envKey` + `wire`). Anthropic-native / Gemini-native providers route best via a codex
  `profile:` instead.
