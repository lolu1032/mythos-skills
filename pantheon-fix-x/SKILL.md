---
name: pantheon-fix-x
description: >-
  A skill that FIXES an existing bug or gap in a real repo through a multi-agent harness (enhanced
  variant: GPT-5.5 cross-model adversarial verification). Same baseline → plan → N isolated-worktree
  fixes (regression-gated + repro-gated) → adversarial verify → judge-picks-the-minimal-patch pipeline
  as pantheon-fix, but the reviewers that try to BREAK each fix are **GPT-5.5 (Codex)**, not Claude — so
  a different model attacks the patch Claude wrote, catching single-model blind spots. Outputs a diff;
  doesn't touch your working tree unless apply:true. Requires a Codex CLI login + the codex plugin. Use
  when the user says "pantheon fix x", "fix with GPT-5.5 verify", "cross-model fix", "코덱스로 고쳐",
  "GPT로 검증해서 고쳐", "크로스 검증 패치". If Codex/GPT-5.5 isn't available, use pantheon-fix. To pick
  a different verifier model use pantheon-fix-custom; to FIND gaps (not fix) use pantheon-gap-x. Don't
  use for a trivial one-line edit (cost is high).
---

# Pantheon fix harness (enhanced · GPT-5.5 cross-verify)

Identical to **`pantheon-fix`** — baseline → plan → N candidate fixes in isolated `git worktrees`
(regression-gated + repro-gated) → adversarial verify → judge picks the minimal safe patch, diff-only
unless `apply: true` — **except the adversarial reviewers run on GPT-5.5 (Codex)** instead of Claude.
Because a *different* model tries to break what Claude patched, it shrinks single-model blind spots.

This is the **same single source of truth** as `pantheon-fix`: it runs
`../pantheon-fix/pantheon-fix-class.js` with `crossModelVerify: true`. There is no separate copy of the
harness (kept that way on purpose — one class, no drift).

## Requirements
- Everything `pantheon-fix` needs (Workflow on a paid plan; the target is a git repo), **plus**:
- **The `codex:codex-rescue` agent type must be installed** — it's registered by OpenAI's Codex plugin,
  not stock Claude Code; a `codex` CLI login alone does NOT create it:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and the `codex` CLI on PATH. Headless:
  `codex login --device-auth`.
- **Never run with cross-verify if `codex:codex-rescue` is missing** — the adversarial calls come back
  empty and every fix "survives" (verification only pretended to happen). Fall back to `pantheon-fix`.

## Procedure (when this skill triggers)
1. **Check cross-verify availability** — confirm the `codex:codex-rescue` agent type actually exists
   (`/agents`, or whether the Codex plugin is installed). If missing, tell the user and offer to switch
   to `pantheon-fix` (Claude verify).
2. **Pin the repo + the defect, decide parameters** — exactly as in `pantheon-fix`
   (`repo` absolute git path, `gap`, optional `testCommand`, `variants`, `verifiers`, `apply`). One
   defect per run.
3. **Run the Workflow** — **Read `../pantheon-fix/pantheon-fix-class.js`** (the shared core, in the
   sibling `pantheon-fix` directory) and pass its contents inline as the `script` argument. **Fix
   `crossModelVerify: true`:**
   ```
   Workflow({
     script: <contents of ../pantheon-fix/pantheon-fix-class.js>,
     args: { repo, gap, testCommand, variants, verifiers, apply, crossModelVerify: true }
   })
   ```
   (This skill's instruction is itself the approval to call Workflow.)
4. **Report when done** — same as `pantheon-fix`, and **state that GPT-5.5 (Codex) did the verifying**
   (the script logs the verifier). Show the patch; note `testUnverified` if set.

## Pipeline
Same as `pantheon-fix`, with **Verify** running V GPT-5.5 (Codex) reviewers per candidate fix instead
of Claude. Baseline / Plan / Fix / Synthesize are unchanged (Claude).

## Notes
- One-shot per call. One defect per run. Diff-only unless `apply: true`.
- Does not work without Codex installed → fall back to `pantheon-fix`.
- Coding/agentic productivity only. Not for bypassing safety gates.
