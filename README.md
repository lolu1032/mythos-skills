# pantheon-skills

Two Claude Code skills that run a hard coding task through a multi-agent harness instead of a single model pass: **plan → N parallel implementations → adversarial verification → judge**. The point isn't a smarter model — it's that a second (and third) implementation, plus an independent reviewer whose job is to *break* the result, catches bugs a single pass ships green.

It's a packaging of well-worn techniques — best-of-N sampling, tool-integrated self-correction, and LLM-as-judge / adversarial verification — wired into one `/pantheon` command so you don't reassemble them by hand each time. This is scaffolding *around* the model, not a change *to* it: it won't rescue a task the model fundamentally can't reason about, but it reliably tightens correctness on coding work whose answer you can express as tests.

The harness runs a deterministic pipeline:

```
Plan ──▶ Implement (×N parallel) ──▶ Verify (adversarial ×V) ──▶ Synthesize
 │            │ each self-corrects            │ try to BREAK each      │ judge picks winner
 1 planner    │ against its own tests (T1)    │ green build            │ + grafts best ideas
              N builders                       reviewers
```

- **Plan** — derive a tight spec, a test plan that *defines* correctness, and N distinct strategies (before any code).
- **Implement** — N builders implement different strategies in parallel; each runs its own tests and self-corrects on failure (tool-integrated self-verification, up to 5 iterations).
- **Verify** — independent adversarial reviewers try to *break* each green build; a build refuted by a majority is dropped.
- **Synthesize** — a judge picks the winner and lists superior ideas worth grafting from the runners-up.

The value: a build can pass its *own* tests yet still be wrong. The adversarial layer catches defects the self-written tests miss, instead of rubber-stamping a green build.

## The two skills

| Skill | Adversarial verifier | Requirements |
|-------|----------------------|--------------|
| **`pantheon`** | Claude itself (independent agents) | Paid Claude Code plan + Workflows (see below) |
| **`pantheon-x`** | **GPT-5.5 via Codex plugin** (cross-model) | Above **+** OpenAI Codex plugin (`codex:codex-rescue`) |

`pantheon-x` is the stronger setting: the implementation written by Claude is attacked by a *different* model, which shrinks single-model blind spots (the same mistake slipping past a same-model verifier). If you don't have Codex/GPT-5.5, use `pantheon`.

Both skills share the same harness (`pantheon-class.js`); they differ only in the `crossModelVerify` flag.

## Requirements

These skills drive Claude Code's **Workflow** orchestration engine, so a stock/Free setup is not enough:

- **Claude Code ≥ v2.1.154** on a **paid plan** — Pro, Max, Team, or Enterprise (also Bedrock / Vertex / Foundry). **Not available on the Free tier.**
- On **Pro**, enable it once: `/config` → turn on **Dynamic workflows**.
- **`pantheon-x` only:** the cross-model verifier runs as the `codex:codex-rescue` subagent, which ships in OpenAI's **Codex plugin** — *not* stock Claude Code. A logged-in `codex` CLI alone does **not** register it. Install the plugin:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and the `codex` CLI on PATH. **If `codex:codex-rescue` isn't installed, use `pantheon` instead** — `pantheon-x` would otherwise silently skip the adversarial pass and pass every build.

Skills and subagents themselves are stock Claude Code features; no extra setup beyond the above.

## Install

Clone into your Claude Code skills directory (personal install):

```bash
git clone https://github.com/lolu1032/pantheon-skills.git
cp -R pantheon-skills/pantheon       ~/.claude/skills/pantheon
cp -R pantheon-skills/pantheon-x     ~/.claude/skills/pantheon-x
```

Or for a single project, copy into `<project>/.claude/skills/`.

## Usage

In Claude Code:

```
/pantheon    <a hard implementation task whose correctness is testable>
/pantheon-x  <same, but GPT-5.5 does the adversarial verification>
```

Example:

```
/pantheon 결제 모듈에 멱등키 처리 추가, 동시요청 중복결제 방지. 테스트는 pnpm test (vitest)
```

Claude collects the parameters (`task`, `workdir`, `lang` + test command, `variants`, `verifiers`) and launches the harness as a background Workflow, then reports: per-variant test results, which builds the adversarial pass broke, and the final winner with its rationale and grafting suggestions.

### Parameters

| arg | default | notes |
|-----|---------|-------|
| `task` | — | one-paragraph requirement + acceptance criteria (expressible as tests) |
| `workdir` | `/tmp/pantheon-<name>` | absolute path; a real repo or a scratch dir |
| `lang` | Python/unittest | language **+ the exact test command** for your stack |
| `variants` | 3 | bump to 5 for harder problems |
| `verifiers` | 2 | bump to 3 to be stricter (majority refutation drops a build) |
| `crossModelVerify` | `false` (`pantheon`) / `true` (`pantheon-x`) | route adversarial verify to GPT-5.5/Codex |

## Cost & scope

- **Not a daemon.** Each invocation runs once to completion and exits — zero cost when idle.
- A run spends real tokens. A representative run is ~11 subagents and a few hundred K to ~1M tokens end-to-end, ~6–10 min wall-clock; heavier settings (`variants=5`, `verifiers=3`, cross-model) cost more. On Pro/Max it draws from your usage quota; on metered API access, budget a few dollars per run and up. **Route only the hardest 10–20% of tasks here** — use plain Opus for the rest.
- This buys *correctness on testable work*, not raw model intelligence. If a task isn't expressible as tests, the adversarial layer has little to grip and the overhead isn't worth it.
- Coding/agentic productivity only. **Not** a tool for bypassing safety gates (cybersecurity/biology capability restrictions).

## FAQ

**Isn't this just a prompt wrapper?**
There's no model change — it's orchestration, yes. The non-trivial part is the *adversarial* step: an independent agent (a different model in `pantheon-x`) whose job is to break a build rather than confirm it. That's what catches defects the builder's own green tests rubber-stamp. The value is the harness shape, not a secret prompt.

**Do you have benchmarks vs. plain Opus?**
No formal benchmark yet — treat the description as *mechanism*, not a measured delta. The value is in the adversarial step: a build can pass its own tests and still be wrong, and an independent reviewer catches what the self-written tests rubber-stamp. If you run a head-to-head, I'd genuinely like to see the numbers.

**What does a run cost?**
A few hundred K to ~1M tokens and ~6–10 min at default settings; more for `variants=5` / `verifiers=3` / cross-model. It's meant for the hardest 10–20% of tasks, not everyday edits. See [Cost & scope](#cost--scope).

**It says "Workflow tool not found" / nothing happens.**
You're likely on the Free tier, or haven't enabled workflows. See [Requirements](#requirements) — needs a paid plan and, on Pro, `/config` → **Dynamic workflows**.

**Why route verification to GPT-5.5 / another vendor's model?**
Same-model verifiers share blind spots — a mistake the builder makes, a same-model reviewer tends to miss too. A *different* model is a cheap way to break that correlation. It's optional: `pantheon` runs Claude-on-Claude and still helps.

## Status

Solo project, **as-is, best-effort**. Issues and PRs are welcome, but maintenance comes with no guarantees or SLA — I may not get to everything. It's MIT-licensed, so forking is a first-class option if you want to take it further.

## License

[MIT](./LICENSE)
