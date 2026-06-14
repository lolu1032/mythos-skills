# mythos-skills

Claude Code skills that wrap **Claude Opus 4.8** in a *Mythos-class* multi-agent coding harness — recovering much of the long-horizon autonomy and correctness of a higher-tier model **without changing the model itself**.

> You can't upgrade a model's weights from the client side. But Opus's gap to a Mythos-class model lives mostly in *scaffolding* — long-horizon autonomy, turn efficiency, self-checking. That part is closable with orchestration, and that's what these skills do.

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
| **`mythos`** | Claude itself (independent agents) | Paid Claude Code plan + Workflows (see below) |
| **`mythos-x`** | **GPT-5.5 via Codex plugin** (cross-model) | Above **+** OpenAI Codex plugin (`codex:codex-rescue`) |

`mythos-x` is the stronger setting: the implementation written by Claude is attacked by a *different* model, which shrinks single-model blind spots (the same mistake slipping past a same-model verifier). If you don't have Codex/GPT-5.5, use `mythos`.

Both skills share the same harness (`mythos-class.js`); they differ only in the `crossModelVerify` flag.

## Requirements

These skills drive Claude Code's **Workflow** orchestration engine, so a stock/Free setup is not enough:

- **Claude Code ≥ v2.1.154** on a **paid plan** — Pro, Max, Team, or Enterprise (also Bedrock / Vertex / Foundry). **Not available on the Free tier.**
- On **Pro**, enable it once: `/config` → turn on **Dynamic workflows**.
- **`mythos-x` only:** the cross-model verifier runs as the `codex:codex-rescue` subagent, which ships in OpenAI's **Codex plugin** — *not* stock Claude Code. A logged-in `codex` CLI alone does **not** register it. Install the plugin:
  ```
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  ```
  plus a ChatGPT subscription (or `OPENAI_API_KEY`) and the `codex` CLI on PATH. **If `codex:codex-rescue` isn't installed, use `mythos` instead** — `mythos-x` would otherwise silently skip the adversarial pass and pass every build.

Skills and subagents themselves are stock Claude Code features; no extra setup beyond the above.

## Install

Clone into your Claude Code skills directory (personal install):

```bash
git clone https://github.com/lolu1032/mythos-skills.git
cp -R mythos-skills/mythos       ~/.claude/skills/mythos
cp -R mythos-skills/mythos-x     ~/.claude/skills/mythos-x
```

Or for a single project, copy into `<project>/.claude/skills/`.

## Usage

In Claude Code:

```
/mythos    <a hard implementation task whose correctness is testable>
/mythos-x  <same, but GPT-5.5 does the adversarial verification>
```

Example:

```
/mythos 결제 모듈에 멱등키 처리 추가, 동시요청 중복결제 방지. 테스트는 pnpm test (vitest)
```

Claude collects the parameters (`task`, `workdir`, `lang` + test command, `variants`, `verifiers`) and launches the harness as a background Workflow, then reports: per-variant test results, which builds the adversarial pass broke, and the final winner with its rationale and grafting suggestions.

### Parameters

| arg | default | notes |
|-----|---------|-------|
| `task` | — | one-paragraph requirement + acceptance criteria (expressible as tests) |
| `workdir` | `/tmp/mythos-<name>` | absolute path; a real repo or a scratch dir |
| `lang` | Python/unittest | language **+ the exact test command** for your stack |
| `variants` | 3 | bump to 5 for harder problems |
| `verifiers` | 2 | bump to 3 to be stricter (majority refutation drops a build) |
| `crossModelVerify` | `false` (`mythos`) / `true` (`mythos-x`) | route adversarial verify to GPT-5.5/Codex |

## Cost & scope

- **Not a daemon.** Each invocation runs once to completion and exits — zero cost when idle.
- A run spends real tokens (a demo run: ~11 agents, ~350k subagent tokens, ~6–7 min). Route only the hardest 10–20% of tasks through it; use plain Opus for the rest.
- Coding/agentic productivity only. **Not** a tool for bypassing safety gates (cybersecurity/biology capability restrictions).

## License

[MIT](./LICENSE)
