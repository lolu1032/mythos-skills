---
name: pantheon-fix
description: >-
  A skill that FIXES an existing bug or gap in a real repo through a multi-agent harness instead of a
  single patch pass. It records a test baseline, plans the fix, then builds N candidate fixes in
  parallel — each in its own isolated git worktree, writing a failing repro test, applying a minimal
  fix, and gating on "no test that passed before now fails" (regression guard) + "the repro test now
  passes" — then has adversarial reviewers (Claude) try to break each fix, and a judge picks the
  smallest, safest patch. It outputs a diff and does NOT touch your working tree unless apply:true.
  Pairs with pantheon-gap (which finds the gaps). Use when the user says "pantheon fix", "fix this bug
  with pantheon", "fix this gap", "patch this safely", "fix it without regressions", "이거 고쳐줘
  판테온으로", "버그 고쳐", "갭 고쳐", "회귀 없이 고쳐", "패치 만들어줘". For GPT-5.5 cross-model
  verification use pantheon-fix-x; to pick the verifier model use pantheon-fix-custom. For REVIEWING
  (finding gaps, not fixing) use pantheon-gap; for GENERATING new code use pantheon. Don't use for a
  trivial one-line edit (cost is high).
---

# Pantheon fix harness (Claude adversarial verify)

Turns a **known defect in an existing repo** into a **verified, regression-safe patch**. Where
`pantheon` generates fresh code and `pantheon-gap` only *reports* gaps, this skill closes the loop:
it edits real code, but safely — every candidate fix runs in an **isolated `git worktree`**, so your
working tree is never touched, and the output is a **diff you review before applying**.

`pantheon-gap` (diagnose) → **`pantheon-fix` (operate)**.

## What makes it safe
- **Worktree isolation** — each of the N fix variants works in its own `git worktree` (a throwaway
  checkout at HEAD). Your actual working tree is left alone.
- **Regression gate** — each variant records which tests pass at HEAD *before* fixing, then re-runs the
  full suite after; if any previously-passing test now fails, that variant is marked `regressed` and
  dropped. (CLAUDE.md rule: never break working code.)
- **Repro gate** — for a testable defect, the variant first writes a test that *reproduces* the bug
  (must fail first), then must make it pass. A fix that doesn't actually fix the bug can't win.
- **Diff-only by default** — the winning patch is returned as text. It is applied to your working tree
  **only if you pass `apply: true`**. Nothing is ever committed.

## Requirements
- **Workflow orchestration** — a paid plan (Pro/Max/Team/Enterprise, v2.1.154+); on Pro enable
  `/config` → Dynamic workflows. Not on Free.
- **The target must be a git repo** (worktree isolation needs git). A clean working tree gives the
  cleanest diff — commit/stash first if you can; the harness still runs if it's dirty, just warns.

## When to use
- A specific, scoped defect whose fix you want **hammered and regression-checked**, not a one-shot edit
  — a concurrency bug, an edge-case crash, a gap surfaced by `pantheon-gap`.
- Don't use for trivial one-line edits (just edit directly) or for finding *what's* wrong (that's
  `pantheon-gap`) or writing a feature from scratch (that's `pantheon`).

## Procedure (when this skill triggers)
1. **Pin the repo and the defect.**
   - `repo`: the **absolute path** to the target git repo.
   - `gap`: a precise description of the bug/gap. If the user is acting on a `pantheon-gap` report,
     paste the relevant gap's title + evidence (file:line) + suggested fix into `gap`. **One defect per
     run** — for several gaps, run it once each (keeps each patch minimal and reviewable).
   - If the defect is unclear, ask 1–2 short questions — *what does "fixed" look like, and can a test
     show it* is the key.
2. **Decide the parameters:**
   - `repo` (absolute path, required), `gap` (required).
   - `testCommand`: the exact suite command if you know it (e.g. `pnpm test`, `go test ./...`,
     `python3 -m unittest`); otherwise the Baseline agent detects it.
   - `variants`: usually 3, up to 5. `verifiers`: usually 2, up to 3.
   - `apply`: omit (or `false`) to get a diff only; `true` to also apply it to the working tree (still
     not committed). Default to diff-only unless the user says "just fix it / apply it."
3. **Run the Workflow** — **Read `pantheon-fix-class.js` in this same directory** and pass its contents
   inline as the `script` argument:
   ```
   Workflow({
     script: <contents of pantheon-fix-class.js>,
     args: { repo, gap, testCommand, variants, verifiers, apply }
   })
   ```
   (This skill's instruction is itself the approval to call Workflow.)
4. **It runs in the background.** When the completion notice arrives, report: the baseline (was the
   suite green to start), per-variant outcome (regressed? repro passed? lines changed), who the
   adversarial reviewers broke vs. who survived, the winner's rationale and confidence, and **show the
   patch**. Note if `testUnverified` (the defect couldn't be confirmed by an automated test — e.g. docs
   drift) so the user reviews extra carefully. If `apply` was false, remind them to review and
   `git apply` the patch.

## Pipeline (what the script does)
- **Baseline** — confirm git, detect the test command, record HEAD's passing tests. Aborts if not git.
- **Plan** — restate the defect, decide if it's test-reproducible, propose N distinct fix strategies.
- **Fix** — N variants in parallel, each in its own worktree: write the repro test, apply a minimal
  fix, loop fix→re-run up to 5× until the repro passes and nothing regressed (T1).
- **Verify** — for each candidate, V adversarial reviewers (Claude) try to break it: does the bug still
  reproduce nearby? did the patch introduce a new regression the suite missed? is the change too broad?
- **Synthesize** — a judge picks the smallest, safest surviving patch; lists grafting suggestions;
  outputs the diff (and applies it only if `apply: true`). Worktrees are cleaned up.

## Notes
- **Not a resident process.** One-shot per call, then exits.
- **One defect per run** keeps the patch minimal and the diff easy to review — that's the point.
- For GPT-5.5 cross-model verification use **`pantheon-fix-x`**; to pick the verifier model (DeepSeek,
  Qwen, local Ollama, …) use **`pantheon-fix-custom`**.
- Coding/agentic productivity only. Not for bypassing safety gates.
