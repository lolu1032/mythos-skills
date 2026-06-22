---
name: pantheon-fix-custom
description: >-
  A skill that FIXES an existing bug or gap in a real repo through a multi-agent harness (configurable
  variant: the user PICKS which AI model runs the adversarial verification — including non-Anthropic
  models like DeepSeek, Qwen, Kimi, or a local Ollama/LM Studio model). Same baseline → plan → N
  isolated-worktree fixes (regression-gated + repro-gated) → adversarial verify → judge-picks-the-
  minimal-patch pipeline as pantheon-fix, but the model that tries to BREAK each fix is chosen per run
  via a `verifier` argument. Outputs a diff; doesn't touch your working tree unless apply:true. Use when
  the user says "pantheon fix custom", "fix and verify with deepseek/qwen", "have a local model check my
  fix", "외부 모델로 검증해서 고쳐", "딥시크로 패치 검증", "오픈클로처럼 검증 모델 골라서 고쳐". If no
  model is given it defaults to Claude (= pantheon-fix). For the fixed presets use pantheon-fix (Claude)
  / pantheon-fix-x (GPT-5.5). Configure the model with /pantheon-model. To FIND gaps (not fix) use
  pantheon-gap-custom. Don't use for a trivial one-line edit (cost is high).
---

# Pantheon fix harness (configurable · user-selectable verifier model)

Identical to **`pantheon-fix`** — baseline → plan → N candidate fixes in isolated `git worktrees`
(regression-gated + repro-gated) → adversarial verify → judge picks the minimal safe patch, diff-only
unless `apply: true` — **except you pick which AI model runs the adversarial-verify step per run**.
`pantheon-fix` always uses Claude; `pantheon-fix-x` always uses GPT-5.5. This one points the verifier
at **any model the harness can reach** — DeepSeek, Qwen, Kimi, a local Ollama/LM Studio model, your own
provider, or a Claude tier.

Same **single source of truth** as `pantheon-fix`: it runs `../pantheon-fix/pantheon-fix-class.js` (the
shared core already contains the full verifier routing) with a `verifier` argument. No separate copy.

Configure the model once with **`/pantheon-model`** (it saves your pick to `~/.pantheon/config.json`,
OpenClaw-style, and sets up any API key in a file — never in chat), or name one inline per run. The
`verifier` value is an OpenClaw-style `provider/model-id` or a friendly alias:

| `verifier` value | adversarial verify runs on | setup needed |
|------------------|----------------------------|--------------|
| omitted / `claude` | Claude (session model) — same as `pantheon-fix` | none |
| `opus` / `sonnet` / `haiku` / `fable` | that Claude tier | none |
| `codex` / `gpt` | GPT-5.5, via the Codex **plugin** (`codex:codex-rescue`) | Codex plugin |
| `deepseek` | DeepSeek (`deepseek-chat`) | `DEEPSEEK_API_KEY` |
| `qwen` | Qwen2.5-Coder via OpenRouter | `OPENROUTER_API_KEY` |
| `kimi` | Kimi / Moonshot | `MOONSHOT_API_KEY` |
| `ollama:<model>` / `lmstudio:<model>` | a **local** model | `codex` CLI + local server running |
| `profile:<name>` / `model:<name>` | a codex profile / model id | `codex` CLI configured |

Cloud providers are called directly via their `/chat/completions` endpoint; local/profile models go
through `codex exec`; Claude tiers and GPT-5.5 (plugin) run natively.

## Requirements
- Everything `pantheon-fix` needs (Workflow on a paid plan; the target is a git repo), **plus** whatever
  the chosen verifier needs:
  - Claude tiers (`opus`/`sonnet`/`haiku`/`fable`) → nothing extra.
  - `codex`/`gpt` → the `codex:codex-rescue` agent (Codex plugin).
  - Cloud (`deepseek`/`qwen`/`kimi`/…) → the matching `*_API_KEY` (in `~/.pantheon/env`, which the
    harness sources; set it up via `/pantheon-model`).
  - Local (`ollama:`/`lmstudio:`) → `codex` CLI on PATH + the local server up with the model pulled.
- **If the chosen verifier can't actually run** (key unset, model unreachable, codex missing), the
  driver returns a no-defect verdict tagged "external verifier unavailable" rather than fabricating one
  — so a fix won't be falsely broken, but verification didn't really happen. Check availability first.

## Procedure (when this skill triggers)
1. **Resolve the verifier:**
   1. If the user named a model inline ("verify with deepseek", "ollama/qwen2.5:7b로 검증"), use it for
      this run only.
   2. Else **Read `~/.pantheon/config.json`** and use its `verifier` (and keep its `providers` block to
      pass along).
   3. If there's no config, send the user to **`/pantheon-model`** once (it lists what's available and
      sets up keys), or proceed with the Claude default (= `pantheon-fix`) for this run.
2. **Sanity-check the verifier can run** (same matrix as `pantheon-custom` step 2): Claude tier →
   nothing; `codex`/`gpt` → plugin installed; cloud → key present (`printenv <ENVKEY>` or
   `~/.pantheon/env`); local → codex + server up. If it can't, offer a Claude tier or `pantheon-fix`.
3. **Pin the repo + the defect, decide parameters** — exactly as in `pantheon-fix` (`repo`, `gap`,
   `testCommand`, `variants`, `verifiers`, `apply`), plus `verifier`. One defect per run.
4. **Run the Workflow** — **Read `../pantheon-fix/pantheon-fix-class.js`** (the shared core, in the
   sibling `pantheon-fix` directory) and pass its contents inline as the `script`. **Pass the chosen
   `verifier`:**
   ```
   Workflow({
     script: <contents of ../pantheon-fix/pantheon-fix-class.js>,
     args: { repo, gap, testCommand, variants, verifiers, apply, verifier, providers }
   })
   ```
   (`providers` = the `providers` block from `~/.pantheon/config.json` if present; omit it and the
   built-in ~15-provider catalog still routes. This skill's instruction is itself the approval to call
   Workflow.)
5. **Report when done** — same as `pantheon-fix`, and **state which model did the verifying** (the
   script logs it). Show the patch; note `testUnverified` if set.

## Pipeline
Same as `pantheon-fix`, with **Verify** running V reviewers **on the chosen `verifier` model** per
candidate fix. For external/local models a driver relays the model's structured verdict (cloud via
direct `/chat/completions`, local/profile via `codex exec`). Baseline / Plan / Fix / Synthesize are
unchanged (Claude).

## Notes
- One-shot per call. One defect per run. Diff-only unless `apply: true`.
- The external model does the actual judging; Claude only transports its verdict, so cross-vendor
  independence holds.
- Coding/agentic productivity only. Not for bypassing safety gates.
