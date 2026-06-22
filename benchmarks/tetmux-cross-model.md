# Benchmark: cross-model (`-x`) variants on a real Go TUI feature

**Project:** tetmux — a Go terminal multiplexer (bubbletea + PTY + a vendored vt10x emulator).
**Task chain:** add a cmux-style mouse drag-to-resize divider, then review it, then fix the findings.
**Method:** every base/`-x` pair ran on identical inputs in isolated repo copies (the real repo was untouched until a winner was synthesized). `-x` routes the adversarial step to GPT-5.5 (Codex); base keeps it on Claude. One vendor's model attacking another's code is the only intended variable.

> **How to read this.** Single trial per stage, so treat the *mechanisms* as the takeaway and the exact counts as one sample. The cleanest verifier-isolating result is the **fix** stage (§3); §1 and §2 surface real defects but don't fully isolate the verifier as the cause (see each takeaway). Caveats are called out inline and in the Bottom line.

---

## 1. Implementation — `pantheon` vs `pantheon-x`

Same task, 3 variants each, isolated worktrees, tests as the gate.

| | `pantheon` (Claude verify) | `pantheon-x` (Codex verify) |
|---|---|---|
| Agents / tokens | 11 / ~1.02M | 11 / ~0.80M |
| Variants green (tests pass) | 3 / 3 | 3 / 3 |
| Adversarial refutations | 0 (all 3 "survived") | 1 variant refuted: delta-from-anchor (2 verifiers confirmed) |
| Winner | v2 (absolute-X, geometry in layout) | v0 (absolute-X, no-jump seed) |
| Unique catch | — | Codex *proved* the "delta-from-grab-anchor" strategy desyncs at the `MinBoardWidth` clamp boundary; also flagged a runner-up whose tests were green-on-disk but failed on a fresh run |

**Takeaway:** cross-model verify killed a candidate with a *demonstrated* defect — a clamp-boundary desync it proved with a failing case — while same-model verify produced 0 refutations on its run. Caveat on attribution: plan + build regenerate per run, so the two runs **don't share a candidate set** — base never saw `-x`'s `delta-from-anchor` approach. So this shows cross-model verify catching a real defect; it does **not**, on this data, show that same-model verify would have missed *that same* defect. Both winners independently converged on absolute-X mapping; the human synthesis took base v2's structure and grafted `-x`'s no-jump behavior.

## 2. Review — `pantheon-gap` vs `pantheon-gap-x`

Read-only audit, 5 dimensions, 2 verifiers/finding.

| | `pantheon-gap` (Claude confirm) | `pantheon-gap-x` (Codex confirm) |
|---|---|---|
| Agents / tokens | 55 / ~2.32M | 55 / ~1.20M |
| Gaps found → confirmed | 24 → 20 | 24 → 19 |
| Shared headline (P0) | ✅ X10 release dropped → stuck drag | ✅ same (independently) |
| Unique confirmed gap | raw unclamped offset → keyboard nudge dead ~94 presses | short-terminal row overlap / drag starts while `TooSmall` |

**Takeaway:** both runs independently confirmed the same P0, and the **union** of the two confirmed sets is wider than either alone. Read this as *coverage union*, not "each model caught what the other missed" — in the gap skills the **probe (gap-finding) is Claude in both runs**; only the confirm/dismiss step differs by model, and confirm can only *drop* a finding, never add one. So a confirmed gap unique to one run is as likely to be **Claude probe run-to-run variance** as a confirm-model signal. Codex's confirm was slightly stricter (19 vs 20). Caveat: concurrent gap runs have previously hit Anthropic rate-limits that skew confirm counts — treat the exact 20/19 as approximate unless verified un-throttled.

## 3. Fix — `pantheon-fix-x` (Codex verify)

Baseline 182/182 green. 3 fix variants, each in its own git worktree, regression-gated + repro-gated, then Codex tried to break each. Diff-only (working tree untouched).

| Variant | Strategy | Own suite | Codex verdict |
|---|---|---|---|
| v1 | router dispatch guard | FAIL (gravity-induced game-over leaves drag active) | refuted |
| v2 | `tea.Tick` frame loop + `DragSession` | FAIL (orphaned-tick: `endDrag` never reset the tick flag) | refuted |
| **v0 (winner)** | layout clamp round-trip + `endDrag` chokepoint + frame-coalesce | pass / vet / gofmt clean | refuted — but best of 3 |

- Agents / tokens: 13 / ~0.92M.
- All 7 confirmed defects fixed by v0 (release routing, `endDrag` chokepoint, clamped-offset write-back, test helper, motion coalescing, unchanged-size guard, short-terminal gate).
- **The key result:** Codex also found a real *residual* defect in the winning variant — `endDrag` gated the background-window reflow on `dragDirty`, but a frame tick clears `dragDirty` while resizing only the visible pane, so a release right after a tick leaves background PTYs at a stale width. A same-model judge had already blessed v0; **the cross-model reviewer broke it.**
- **Human-in-the-loop close:** applied v0, removed the pending gate (`if wasActive { reflow() }`), and added a regression test proven to fail on the old code (`ResizeCalls 0→0`) and pass on the fix — i.e. not a tautology.

## 4. Cost

| Run | Agents | Output tokens |
|---|---|---|
| `pantheon` (impl) | 11 | ~1.02M |
| `pantheon-x` (impl) | 11 | ~0.80M |
| `pantheon-gap` | 55 | ~2.32M |
| `pantheon-gap-x` | 55 | ~1.20M |
| `pantheon-fix-x` | 13 | ~0.92M |

## 5. Bottom line

- `-x` differs from base in exactly one step — **who runs the adversarial verify** (GPT-5.5/Codex vs Claude). Everything else (plan, build, judge) stays Claude.
- The cleanest result is the **fix** stage (§3): the cross-model reviewer broke a patch the same-model judge had already chosen, and the residual was a real, reproducible defect (closed with a failing-first test). In the impl and review stages the cross-model path also surfaced real defects, but those runs don't fully isolate the verifier as the cause (different candidate sets in §1; Claude-only probe in §2) — read them as **suggestive, not measured**.
- **Single trial per stage.** Multi-agent runs vary run-to-run; the *mechanisms* are the takeaway, the exact counts are one sample. To isolate the verifier cleanly: pin identical candidates/dimensions and feed the *same* set to both verifiers.
- **Not free:** Codex round-trips are slower and the gap runs are the expensive ones. Route `-x` to changes that are expensive to get wrong (state machines, concurrency, migrations); use base for routine work.
- The harness **never edited the real tree** (worktree isolation + diff-only); a human applied the winner and closed the one residual defect with a failing-first regression test.
