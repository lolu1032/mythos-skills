---
name: pantheon-gap-x
description: >-
  A skill that runs a GAP ANALYSIS & feedback review of an existing project through a multi-agent
  harness (enhanced variant: GPT-5.5 cross-model adversarial confirmation). It maps the project, fans
  out one probe agent per dimension (completeness, correctness, tests, security, docs, architecture,
  DX, performance, ops) to hunt for what's MISSING or weak with file-level evidence, then has
  **GPT-5.5 (Codex) skeptical reviewers** try to DISMISS each finding so false positives are dropped,
  and finally a judge dedups and prioritizes a report (top gaps, quick wins, the highest-leverage next
  fix). Because a *different* model judges each finding, it strips same-model confirmation bias harder
  than the base (pantheon-gap). Requires a Codex CLI login. Use when the user says "pantheon gap x",
  "cross-model gap analysis", "GPT-5.5 review my project", "코덱스로 갭 분석", "크로스 검증 프로젝트
  점검". If Codex/GPT-5.5 isn't available, use the pantheon-gap skill instead. For GENERATING code (not
  reviewing an existing project), use pantheon / pantheon-x. Don't use for a quick single-file glance.
---

# Pantheon gap-analysis harness (enhanced · GPT-5.5 cross-verify)

The review/audit twin of `pantheon-x`. Same `map → probe (×N dimensions) → adversarial confirm →
synthesize` pipeline as the `pantheon-gap` base, but the **adversarial confirm step is run by GPT-5.5
(Codex)** (`agentType: 'codex:codex-rescue'`). Because a *different* model tries to dismiss each
finding, it doesn't share the Claude probe's "I found a gap" confirmation bias — so the false
positives a same-model review keeps get stripped harder.

## Requirements
- **Workflow orchestration** — a paid plan (Pro/Max/Team/Enterprise, v2.1.154+); on Pro enable
  `/config` → Dynamic workflows. Same as `pantheon-gap`. Not on the Free tier.
- **The `codex:codex-rescue` agent type must be installed.** It's a subagent registered by OpenAI's
  **Codex plugin**, not stock Claude Code; a `codex` CLI login alone does NOT create it:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and the `codex` CLI on PATH. On a headless server,
  `codex login --device-auth`.
- **Never run if `codex:codex-rescue` is missing.** The confirm calls all come back empty, so every
  finding "survives" unconfirmed and the report fills with false positives. Fall back to `pantheon-gap`.

## When to use
- A real project/repo you want an evidence-backed, *cross-checked* gap list for — before a launch,
  after an MVP, inheriting a codebase — where a second vendor's model filtering the findings is worth
  the extra cost.
- Don't use it to *write* code — that's `pantheon` / `pantheon-x`. Don't use it for a trivial one-file
  look. Each run costs real tokens (Codex round-trips included).

## Procedure (when this skill triggers)
1. **Check cross-verify availability.** Confirm the `codex:codex-rescue` agent type is actually
   installed (the `/agents` list, or whether the Codex plugin is installed). What matters is the
   *existence of this agent type*, not just a `codex` CLI login — forcing it without the agent silently
   disables confirmation and every finding passes. If it's missing, tell the user and offer to switch
   to the `pantheon-gap` base (Claude's own adversarial confirm).
2. **Pin the target.** Which project/path is being reviewed, and is there a focus (e.g. "security and
   tests only")? If unclear, ask 1 short question.
3. **Decide the parameters:**
   - `target`: an **absolute path** to the project root to audit.
   - `dimensions` (optional): an explicit list to audit; omit to let the scout pick the most relevant.
   - `focus` (optional): a dimension or area to emphasize.
   - `maxDimensions`: how many dimensions to probe (default 6).
   - `verifiers`: skeptical GPT-5.5 reviewers per finding (default 2; bump to 3 to be stricter — a
     finding is kept only if a majority confirm it).
4. **Run the Workflow** — **Read `pantheon-gap-class.js` in this same directory**, then pass its
   contents inline as the Workflow `script` argument. **Fix `crossModelVerify: true`:**
   ```
   Workflow({
     script: <contents of pantheon-gap-class.js>,
     args: { target, dimensions, focus, maxDimensions, verifiers, crossModelVerify: true }
   })
   ```
   (This skill's instruction is itself the approval to call Workflow.)
5. **It runs in the background.** When the completion notice arrives, report: which dimensions were
   probed, how many gaps were found vs. confirmed by GPT-5.5 (survived adversarial dismissal), the top
   prioritized gaps, the quick wins, and the single highest-leverage fix.

## Pipeline (what the script does)
- **Map** — one scout reads the README/structure/manifests/tests/CI, names the project's stated
  purpose and maturity, and picks the dimensions worth auditing for THIS project.
- **Probe** — one Claude agent per dimension hunts for gaps (missing/incomplete/weak), each citing
  file-level evidence; high-signal findings over a long noisy list.
- **Confirm** — for each candidate gap, V **GPT-5.5 (Codex) skeptics** try to DISMISS it (already
  handled? out of scope? false positive?); a gap is kept only if a majority confirm it.
- **Synthesize** — a judge (Claude) dedups and prioritizes by impact × effort: top gaps, quick wins,
  and the highest-leverage next fix.

## Notes
- **Not a resident process.** One-shot per call, then exits — zero cost when idle.
- It **reports** gaps; it does not fix them. Hand the report to `pantheon` (or plain Opus) to act on.
- The cross-model *confirm* step is the point: a different vendor's model is maximally independent from
  the Claude probe, so it kills the plausible-but-false findings a same-model review ships.
- Does not work without Codex installed → fall back to `pantheon-gap`.
- Coding/agentic productivity only. Not for bypassing safety gates.
