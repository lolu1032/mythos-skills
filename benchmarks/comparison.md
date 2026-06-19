# Pantheon — verifier-model comparison

Same task / same harness, only the **adversarial model differs**. The point isn't "which model is
best" — it's to see whether a different verifier reaches a *different verdict* (breaks a build the
others passed, confirms/dismisses a gap differently). Run on 2026-06-20.

- **Plan:** Claude (Opus) — same for every run.
- **Builders:** Claude (Opus) — same for every run.
- **Only the Verify / Confirm step changes** per skill.
- Light settings to keep cost down: generation `variants=2, verifiers=1`; review `maxDimensions=3, verifiers=1`.
- Models available for this run: **Claude**, **GPT-5.5 (Codex)**, **DeepSeek** (`deepseek-chat`). Grok excluded.

---

## Phase 1 — Generation (`merge_intervals`)

**Task:** `merge_intervals(intervals)` in pure Python 3 (stdlib): merge overlapping *or touching*
integer intervals, return a new sorted list. Edge cases: empty, single, fully nested, duplicates,
unsorted/reverse, negatives, no input mutation. Tests via `python3 -m unittest`.

| Skill | Verifier | Builds green | Refuted (broken) | Survivors | Winner | Verifier's finding |
|-------|----------|--------------|------------------|-----------|--------|--------------------|
| `pantheon` | Claude | 2/2 | 0 | 2 (both) | variant-0 (sorted-sweep-fold) | No defect found; ran +17 own adversarial edge cases (empty, degenerate points, touch-at-zero) → both identical, correctness a tie; picked winner on readability over variant-1's clever event-sweepline |
| `pantheon-x` | GPT-5.5 (Codex) | 2/2 | 0 | 2 (both) | variant-0 | Native codex-plugin path (not the custom-provider route). Differential-fuzzed 20k cases, 0 mismatches → no defect to find |
| `pantheon-custom` | DeepSeek | 2/2 | — | — | variant-0 | ⚠️ **DeepSeek never actually ran.** codex 0.139.0 dropped `wire_api=chat`; DeepSeek has no `/responses` endpoint (only `/chat/completions`) → driver fell back to the "unavailable" verdict **without fabricating a defect** (correct behavior). Cloud-via-`codex exec` is broken on this codex version. |

_Task IDs: pantheon `wu9vt56xj`, pantheon-x `w57zieboc`, pantheon-custom `wdhcfg53w`._

**Two findings this phase surfaced:**
1. **Bug → FIXED & validated.** The cloud-provider path routed through `codex exec -c model_providers...`,
   but codex 0.139.0 only speaks the OpenAI *Responses* wire, which chat-only providers (DeepSeek, and
   most OpenAI-compatible vendors) don't implement → 404. **Fix shipped:** cloud providers now call their
   `/chat/completions` endpoint **directly via `curl`** (no codex); local Ollama keeps using
   `codex --oss`. Validated with a live DeepSeek call: `HTTP 200`, returned a clean verdict
   `{"defectFound":false,"severity":"none","description":"No defect found.",...}`. The "unavailable"
   fallback had correctly refused to fake a pass before the fix.
2. **Task too easy:** all three builds were correct, so *no* verifier could break anything — the run
   can't show verifier divergence. A fair comparison needs a task with a subtle, plantable bug.

---

## Phase 2 — Review / gap analysis (pending)

Same target reviewed by three confirm models.

| Skill | Confirm model | Dimensions | Gaps found | Confirmed (survived) | Top gap | Notes |
|-------|---------------|------------|------------|----------------------|---------|-------|
| `pantheon-gap` | Claude | correctness, testing, security | 17 | 5 ⚠️ | provider-catalog drift (15 hardcoded vs 33 in `providers.json`) silently PASSes ~48% of the cloud catalog | Some confirm agents hit **Anthropic rate-limits** (3 gap jobs ran at once) — undercounts |
| `pantheon-gap-x` | GPT-5.5 (Codex) | arch, testing, security | 17 | 12 | **unvalidated `baseUrl` exfiltrates the API key** (a poisoned providers block POSTs the key to an attacker host) | Cleanest run — confirm runs on Codex/OpenAI, not subject to the Anthropic rate-limit |
| `pantheon-gap-custom` | DeepSeek | correctness, testing, arch | 18 | 0 ⚠️ | — | ⚠️ confirm step **rate-limited (Anthropic)** → 0 is an artifact, **not** a real DeepSeek verdict |

_Task IDs: pantheon-gap `wh122l93y`, pantheon-gap-x `wn0jmqq3a`, pantheon-gap-custom `wp0g4n99q`._

---

## Observations

**The verifier-model comparison was confounded twice — but the run was still useful.**

- **Generation (Phase 1) was too easy.** Opus builders produced correct code for `merge_intervals`, so
  *no* verifier (Claude, GPT-5.5, or DeepSeek) could break anything — all returned 0 refutations. You
  can't see verifier divergence when there's no defect to find. It *did* surface — and we fixed — a real
  bug: cloud verifiers routed through `codex`, which 0.139.0 can't do for chat-only providers (see
  finding 1 above). DeepSeek's "verdict" there was the honest "unavailable" fallback, not a real check.
- **Review (Phase 2) was rate-limited.** Running all three gap jobs at once (~22 agents each, ~66
  concurrent) tripped an **Anthropic server-side rate-limit**. The Claude and DeepSeek *confirm* steps
  run as Claude driver agents, so they got throttled (Claude undercounted to 5; DeepSeek collapsed to
  0). GPT-5.5's confirm runs on Codex/OpenAI, so it sailed through with 12. **So the 5 / 12 / 0 spread
  is mostly a rate-limit artifact, not a model-quality signal.** A clean comparison needs the runs
  **sequential** (one at a time).

**What the run genuinely showed:** pointed at its own repo, the gap harness found *real, specific*
defects in this very project — provider-catalog drift (15 vs 33 → silent rubber-stamp), an unvalidated
`baseUrl` that can exfiltrate the API key, no tests/CI, copy-paste harness drift, and a root
`providers.json` that's never installed or read. Several were introduced *this same session*. That —
the tool catching its author's fresh bugs — is the more honest demonstration than the model A-vs-B
numbers.

**To redo this as a fair model comparison:** (1) run each skill **sequentially** (no concurrent
rate-limit); (2) for generation, use a task with a *plantable subtle bug* so verifiers actually diverge
on catching it; (3) keep `verifiers ≥ 2` if you want the "majority" framing to mean anything.
