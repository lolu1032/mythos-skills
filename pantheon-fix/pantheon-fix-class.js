export const meta = {
  name: 'pantheon-fix-class',
  description:
    'Fix an existing bug/gap through a Pantheon harness: baseline -> plan -> N fix variants in isolated git worktrees (regression-gated + repro-gated) -> adversarial verify -> judge picks the minimal safe patch (diff-only unless apply:true)',
  phases: [
    { title: 'Baseline', detail: 'Confirm git repo, detect the test command, record which tests pass at HEAD' },
    { title: 'Plan', detail: 'Restate the bug, decide if it is test-reproducible, propose N fix strategies' },
    { title: 'Fix', detail: 'N variants in parallel, each in its own worktree: write repro test, fix, gate on no-regression + repro-green' },
    { title: 'Verify', detail: 'Adversarial reviewers try to break each candidate fix (incomplete fix / new regression / over-broad)' },
    { title: 'Synthesize', detail: 'Judge picks the minimal, safest patch; output the diff (apply only if asked)' },
  ],
}

// NOTE: the Workflow tool delivers `args` as a JSON STRING (not a parsed object).
// Parse defensively so this works whether args is a string, an object, or absent.
let A = {}
if (typeof args === 'string') { try { A = args ? JSON.parse(args) : {} } catch (e) { A = {} } }
else if (args && typeof args === 'object') { A = args }

const repo = A.repo ?? A.workdir ?? '.' // absolute path to the target git repo (the skill always passes one)
const gap = A.gap ?? A.task ?? A.bug ?? 'No gap/bug description was provided.'
const givenTestCmd = A.testCommand ?? A.test ?? ''
const N = A.variants ?? 3
const V = A.verifiers ?? 2
const crossVerify = A.crossModelVerify ?? false // legacy flag: true => GPT-5.5 (Codex) runs the adversarial step
const doApply = A.apply ?? false // false => emit the diff only, never touch the working tree

const BASELINE_SCHEMA = {
  type: 'object',
  properties: {
    isGit: { type: 'boolean' },
    cleanTree: { type: 'boolean' },
    testCommand: { type: 'string' },
    total: { type: 'number' },
    passing: { type: 'number' },
    green: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['isGit', 'testCommand', 'green'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    bugSpec: { type: 'string', description: 'Precise restatement of the defect and the correct behavior' },
    testCommand: { type: 'string' },
    testable: { type: 'boolean', description: 'Can this defect be reproduced by an automated test?' },
    reproPlan: { type: 'string', description: 'How to write a failing test that reproduces it; or why it is not testable' },
    filesLikelyTouched: { type: 'array', items: { type: 'string' } },
    strategies: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, approach: { type: 'string' } },
        required: ['name', 'approach'],
      },
      description: 'Distinct fix strategies, one per variant',
    },
  },
  required: ['bugSpec', 'testCommand', 'testable', 'strategies'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'number' },
    strategy: { type: 'string' },
    worktree: { type: 'string', description: 'Absolute path to the worktree (kept for the verify phase)' },
    patch: { type: 'string', description: 'Unified diff of the fix (git diff HEAD), including any new test file' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    linesChanged: { type: 'number' },
    suiteTotal: { type: 'number' },
    suitePassing: { type: 'number' },
    regressed: { type: 'boolean', description: 'true if any test that passed at HEAD now fails' },
    reproPasses: { type: 'boolean', description: 'true if the repro test now passes (false/N/A if not testable)' },
    iterations: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['variant', 'patch', 'regressed', 'reproPasses', 'worktree'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    defectFound: { type: 'boolean' },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    description: { type: 'string' },
    failingCase: { type: 'string' },
  },
  required: ['defectFound', 'description'],
}

const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    winner: { type: 'number' },
    rationale: { type: 'string' },
    graftedIdeas: { type: 'array', items: { type: 'string' }, description: 'Better ideas from runners-up (suggestions, NOT in the patch)' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    testUnverified: { type: 'boolean', description: 'true if the fix could not be confirmed by an automated test' },
    reviewNotes: { type: 'string' },
  },
  required: ['winner', 'rationale'],
}

// ---- Phase 1: BASELINE — confirm git, detect the test command, record HEAD's passing tests ----
phase('Baseline')
const baseline = await agent(
  `You are the BASELINE agent in a Pantheon fix harness. Target repo: ${repo}\n\n` +
    `1. Confirm it's a git repo (git -C ${repo} rev-parse --is-inside-work-tree) and whether the working tree is clean (git -C ${repo} status --porcelain — empty = clean).\n` +
    `2. Detect the test command for this project${givenTestCmd ? ` (the caller suggests: \`${givenTestCmd}\` — verify it)` : ' (inspect package.json / pyproject / Makefile / go.mod etc.)'}.\n` +
    `3. Run the FULL existing test suite ONCE at HEAD and report total tests, passing count, and whether the suite is green. Do NOT modify any file.\n` +
    `Report isGit, cleanTree, the exact testCommand, total, passing, green, and notes (e.g. pre-existing failures).`,
  { schema: BASELINE_SCHEMA, phase: 'Baseline', label: 'baseline' },
)
log(`Baseline: git=${baseline.isGit} clean=${baseline.cleanTree} green=${baseline.green} (${baseline.passing ?? '?'}/${baseline.total ?? '?'}) cmd=\`${baseline.testCommand}\``)
if (!baseline.isGit) {
  log('Target is not a git repo — worktree isolation is unavailable; aborting for safety.')
  return { repo, gap, error: 'not a git repository; pantheon-fix needs git for safe worktree-isolated fixing', baseline }
}
const testCmd = baseline.testCommand || givenTestCmd
if (!baseline.cleanTree) log('⚠️ Working tree is not clean — patches will be computed against HEAD; commit/stash first for the cleanest diff.')

// ---- Phase 2: PLAN — restate the bug, decide testability, propose N strategies ----
phase('Plan')
const plan = await agent(
  `You are the PLANNER in a Pantheon fix harness. Target repo: ${repo}\nTest command: \`${testCmd}\`\n\n` +
    `DEFECT / GAP TO FIX:\n${gap}\n\n` +
    `Read the ACTUAL relevant code in the repo (do not speculate). Produce: (1) a precise bugSpec (the defect + the correct behavior), ` +
    `(2) whether it is testable (can a small automated test reproduce it before the fix and pass after?), (3) a reproPlan (exactly how to write that failing test, which test file, or why it is not testable — e.g. docs/config drift), ` +
    `(4) the files likely to change, and (5) exactly ${N} DISTINCT fix strategies (different approaches, not cosmetic variations of one). Keep each fix minimal in scope.`,
  { schema: PLAN_SCHEMA, phase: 'Plan', label: 'plan' },
)
log(`Plan: testable=${plan.testable}; ${plan.strategies.length} fix strategies`)

// ---- Phase 3: FIX — N variants, each in its OWN git worktree, regression- + repro-gated ----
const strategies = plan.strategies.slice(0, N).map((s, i) => ({ s, i }))
const reproClause = plan.testable
  ? `2. Write the repro test described here into the right test file:\n${plan.reproPlan}\n   Run the suite and CONFIRM this new test FAILS first (it must reproduce the bug).`
  : `2. This defect is NOT automatically testable (${plan.reproPlan || 'no repro test possible'}). Skip the repro test; you will rely on the suite staying green plus a manual argument that the fix is correct. Set reproPasses=false.`
const built = await parallel(
  strategies.map(({ s, i }) => () =>
    agent(
      `You are FIXER #${i} in a Pantheon fix harness. Fix ONE defect using ONLY the strategy below — minimal change, do not refactor unrelated code, do not copy the other strategies.\n\n` +
        `REPO: ${repo}\nTEST COMMAND: \`${testCmd}\`\nDEFECT:\n${gap}\nBUG SPEC: ${plan.bugSpec}\nSTRATEGY: ${s.name} — ${s.approach}\n\n` +
        `Work in an ISOLATED git worktree so the user's tree is never touched:\n` +
        `1. wt=$(mktemp -u -t pfix-v${i}.XXXXXX); git -C ${repo} worktree add -d "$wt" HEAD; cd "$wt"\n` +
        `   (run the suite once here first and record WHICH tests pass — this is your per-variant baseline.)\n` +
        `${reproClause}\n` +
        `3. Apply your fix (strategy above) to the code in "$wt". Re-run the FULL suite. T1 LOOP up to 5 times: if the repro test still fails OR any test that passed in your baseline now fails, read the error, adjust the fix (not the suite), re-run.\n` +
        `4. REGRESSION CHECK: regressed=true if any test that passed in your per-variant baseline now fails. reproPasses=true only if the repro test now passes.\n` +
        `5. Capture the patch: git -C "$wt" add -A && git -C "$wt" diff --cached HEAD  → return this unified diff verbatim as \`patch\` (it includes the new test file). Report filesTouched and linesChanged.\n` +
        `6. Do NOT remove the worktree and do NOT commit — leave "$wt" in place and return its absolute path as \`worktree\` (the verify phase reads it).\n` +
        `Report variant ${i}, strategy, worktree, patch, suiteTotal/suitePassing, regressed, reproPasses, iterations, notes.`,
      { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:v${i} (${s.name})` },
    ),
  ),
)
const fixes = built.filter(Boolean)
if (!fixes.length) {
  log('No variant produced a fix; aborting.')
  return { repo, gap, baseline, plan: { bugSpec: plan.bugSpec, testable: plan.testable }, fixes: [], error: 'no fix produced' }
}
// A candidate fix must not regress; if testable it must also make the repro test pass.
const clean = fixes.filter((f) => !f.regressed && (plan.testable ? f.reproPasses : true))
const pool = clean.length ? clean : fixes.filter((f) => !f.regressed)
log(`Fixes: ${fixes.length}; no-regression + repro-green: ${clean.length}; candidate pool: ${pool.length}`)
if (!pool.length) {
  log('Every variant regressed the suite — no safe fix. Returning attempts for inspection.')
  return {
    repo, gap, baseline,
    plan: { bugSpec: plan.bugSpec, testable: plan.testable, strategies: plan.strategies.map((s) => s.name) },
    fixes: fixes.map((f) => ({ variant: f.variant, strategy: f.strategy, regressed: f.regressed, reproPasses: f.reproPasses, linesChanged: f.linesChanged })),
    error: 'no non-regressing fix found',
  }
}

// ---- verifier routing (mirrors pantheon-custom): pick which model runs the adversarial step ----
// '' / 'claude' -> Claude (or GPT-5.5 if crossModelVerify); Claude tier; 'codex'/'gpt' -> Codex plugin;
// OpenClaw-style provider/model-id or alias -> direct /chat/completions (cloud) or `codex exec` (local/profile).
const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', wire: 'chat', defModel: 'deepseek-chat' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', wire: 'chat', defModel: 'qwen/qwen-2.5-coder-32b-instruct' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', wire: 'chat', defModel: 'mistral-large-latest' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', wire: 'chat', defModel: 'llama-3.3-70b-versatile' },
  xai: { baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY', wire: 'chat', defModel: 'grok-4' },
  together: { baseUrl: 'https://api.together.xyz/v1', envKey: 'TOGETHER_API_KEY', wire: 'chat', defModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  moonshot: { baseUrl: 'https://api.moonshot.ai/v1', envKey: 'MOONSHOT_API_KEY', wire: 'chat', defModel: 'kimi-k2-0711-preview' },
  dashscope: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY', wire: 'chat', defModel: 'qwen2.5-coder-32b-instruct' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY', wire: 'chat', defModel: 'gemini-2.5-pro' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', envKey: 'NVIDIA_API_KEY', wire: 'chat', defModel: 'nvidia/llama-3.3-nemotron-super-49b-v1' },
  novita: { baseUrl: 'https://api.novita.ai/v3/openai', envKey: 'NOVITA_API_KEY', wire: 'chat', defModel: 'deepseek/deepseek-v3-0324' },
  perplexity: { baseUrl: 'https://api.perplexity.ai', envKey: 'PERPLEXITY_API_KEY', wire: 'chat', defModel: 'sonar-pro' },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', envKey: 'ZAI_API_KEY', wire: 'chat', defModel: 'glm-4.6' },
  vllm: { baseUrl: 'http://127.0.0.1:8000/v1', envKey: 'VLLM_API_KEY', wire: 'chat', defModel: '' },
  sglang: { baseUrl: 'http://127.0.0.1:30000/v1', envKey: 'SGLANG_API_KEY', wire: 'chat', defModel: '' },
}
const ALIASES = { qwen: 'dashscope', kimi: 'moonshot', grok: 'xai', gemini: 'google', glm: 'zai' }
const providers = Object.assign({}, PROVIDERS, A.providers && typeof A.providers === 'object' ? A.providers : {})
function httpDesc(provId, model) {
  const p = providers[provId]
  return { mode: 'http', baseUrl: p.baseUrl, envKey: p.envKey, model: model || p.defModel || (p.models && p.models[0]) || provId, who: provId + (model ? ' ' + model : '') }
}
function resolveVerifier(v, crossLegacy) {
  const raw = typeof v === 'string' ? v.trim() : ''
  const m = raw.toLowerCase()
  const CLAUDE = ['opus', 'sonnet', 'haiku', 'fable']
  if (!m || m === 'claude' || m === 'default') return crossLegacy ? { mode: 'agent', agentType: 'codex:codex-rescue', who: 'GPT-5.5 (Codex)' } : { mode: 'claude', who: 'Claude (default)' }
  if (CLAUDE.includes(m)) return { mode: 'claude', model: m, who: 'Claude ' + m }
  if (m === 'codex' || m === 'gpt' || m === 'gpt-5.5' || m === 'gpt5.5' || m === 'openai') return { mode: 'agent', agentType: 'codex:codex-rescue', who: 'GPT-5.5 (Codex)' }
  if (raw.includes('/')) {
    const s = raw.indexOf('/'); let prov = raw.slice(0, s).toLowerCase(); const model = raw.slice(s + 1)
    if (prov === 'anthropic' || prov === 'claude') return CLAUDE.includes(model.toLowerCase()) ? { mode: 'claude', model: model.toLowerCase(), who: 'Claude ' + model } : { mode: 'claude', who: 'Claude' }
    if (prov === 'ollama' || prov === 'lmstudio') return { mode: 'codex', codexArgs: ['--oss', '--local-provider', prov, '-m', model], who: prov + ' ' + model + ' (local)' }
    if (prov === 'openai' || prov === 'gpt') return { mode: 'codex', codexArgs: ['-m', model], who: model }
    if (ALIASES[prov]) prov = ALIASES[prov]
    if (providers[prov] && providers[prov].baseUrl) return httpDesc(prov, model)
    return { mode: 'codex', codexArgs: ['-c', `model_provider=${prov}`, '-m', model], who: raw }
  }
  if (m.startsWith('ollama:') || m.startsWith('lmstudio:')) {
    const i = raw.indexOf(':'); const prov = raw.slice(0, i).toLowerCase(); const model = raw.slice(i + 1)
    return { mode: 'codex', codexArgs: ['--oss', '--local-provider', prov, '-m', model], who: prov + ' ' + model + ' (local)' }
  }
  if (m.startsWith('profile:')) { const name = raw.slice(raw.indexOf(':') + 1); return { mode: 'codex', codexArgs: ['-p', name], who: 'codex profile ' + name } }
  if (m.startsWith('model:')) { const name = raw.slice(raw.indexOf(':') + 1); return { mode: 'codex', codexArgs: ['-m', name], who: name } }
  const provId = ALIASES[m] || m
  if (providers[provId] && providers[provId].baseUrl) return httpDesc(provId, null)
  return { mode: 'codex', codexArgs: ['-m', raw], who: raw }
}
const VR = resolveVerifier(A.verifier, crossVerify)
log(`Adversarial verifier: ${VR.who}`)
function verifierAgent(promptCore, meta) {
  if (VR.mode === 'http') {
    return agent(
      `You are a DRIVER. Delegate this adversarial review to an INDEPENDENT external model (${VR.who}) by calling its OpenAI-compatible chat API DIRECTLY (not via codex), then relay ITS verdict. Do NOT judge the code yourself.\n\n` +
        `Steps (use Bash; never print the key):\n` +
        `1. Load the key: [ -f ~/.pantheon/env ] && . ~/.pantheon/env   (sets $${VR.envKey}).\n` +
        `2. Using python3 so the prompt is safely JSON-escaped, write a request-body file with: model="${VR.model}", temperature=0, messages=[{"role":"user","content": THE REVIEW PROMPT BELOW, followed by "Reason about the patch, then output ONLY one compact JSON object with keys defectFound(boolean), severity(one of none|low|medium|high), description(string), failingCase(string)."}].\n` +
        `3. POST it: curl -s -w "\\n%{http_code}" ${VR.baseUrl}/chat/completions -H "Authorization: Bearer $${VR.envKey}" -H "Content-Type: application/json" -d @BODYFILE\n` +
        `4. From the JSON response take choices[0].message.content, extract the verdict JSON object it contains, and return THAT as your structured output (unchanged).\n` +
        `5. If $${VR.envKey} is empty, the HTTP status is not 200, or no JSON comes back, return defectFound=false, severity="none", description="external verifier ${VR.who} unavailable: <short error>". Never fabricate a defect.\n\n` +
        `REVIEW PROMPT <<<\n${promptCore}\n>>>`,
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  if (VR.mode === 'codex') {
    return agent(
      `You are a DRIVER. Delegate this adversarial review to an INDEPENDENT external model (${VR.who}) via the codex CLI, then relay ITS verdict. Do NOT judge the code yourself.\n\n` +
        `Steps (use Bash; create temp files with mktemp):\n` +
        `1. Write this JSON Schema to a file $SCHEMA:\n${JSON.stringify(VERDICT_SCHEMA)}\n` +
        `2. Write the REVIEW PROMPT (between <<< >>> below) to a file $PROMPT.\n` +
        `3. Load saved API keys (if any), then run EXACTLY (OUT = another mktemp file). Do NOT print the keys:\n   [ -f ~/.pantheon/env ] && . ~/.pantheon/env;  codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write -C ${repo} ${VR.codexArgs.join(' ')} --output-schema "$SCHEMA" -o "$OUT" < "$PROMPT"\n   If codex rejects --output-schema for this provider, drop that flag and instead extract the JSON object the model prints to stdout.\n` +
        `4. Read $OUT (or the parsed stdout JSON) and return it as your structured verdict, unchanged.\n` +
        `If codex is missing / the *_API_KEY is unset / the model is unreachable / no JSON is produced, return {"defectFound":false,"severity":"none","description":"external verifier ${VR.who} unavailable: <short error>"} — never fabricate a defect.\n\n` +
        `REVIEW PROMPT <<<\n${promptCore}\n\nReason about the patch, then output ONLY the verdict JSON.\n>>>`,
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  const extra = VR.mode === 'agent' ? { agentType: VR.agentType } : VR.model ? { model: VR.model } : {}
  return agent(promptCore, { schema: VERDICT_SCHEMA, ...meta, ...extra })
}

// ---- Phase 4: ADVERSARIAL VERIFY — try to break each candidate fix ----
const verified = await parallel(
  pool.map((b) => () =>
    parallel(
      Array.from({ length: V }, (_, k) => () =>
        verifierAgent(
          `You are ADVERSARIAL REVIEWER ${k} of a proposed FIX (variant ${b.variant}) for this defect:\n${plan.bugSpec}\n\n` +
            `The fix lives in the worktree ${b.worktree} (the suite passes there). Its patch:\n\n${(b.patch || '').slice(0, 9000)}\n\n` +
            `Your job is to BREAK the fix, not praise it. Look for: (a) the defect still reproduces on a NEARBY input the repro test missed; (b) the patch introduces a NEW bug/regression the suite didn't cover; (c) the change is OVER-BROAD and alters behavior outside the defect's scope. ` +
            `You MAY cd ${b.worktree}, write a tiny extra test/script, and RUN it to PROVE a failure. Set defectFound=false ONLY if you genuinely cannot break it. Return severity and the failing case.`,
          { phase: 'Verify', label: `verify:v${b.variant}.${k}` },
        ),
      ),
    ).then((vs) => {
      const verdicts = vs.filter(Boolean)
      const refutations = verdicts.filter((v) => v.defectFound && v.severity !== 'low')
      return { ...b, verdicts, refutations, refuted: refutations.length >= Math.ceil(V / 2) }
    }),
  ),
)
const survivors = verified.filter(Boolean).filter((v) => !v.refuted)
log(`Survivors after adversarial verify: ${survivors.length}/${pool.length}`)

// ---- Phase 5: SYNTHESIZE — judge picks the minimal, safest patch ----
phase('Synthesize')
const candidates = survivors.length ? survivors : verified.filter(Boolean)
const final = await agent(
  `You are the JUDGE in a Pantheon fix harness for defect: ${plan.bugSpec}\n\nSurviving candidate fixes:\n${candidates
    .map((c) => `- variant ${c.variant} (${c.strategy ?? 'n/a'}): linesChanged=${c.linesChanged ?? '?'}, regressed=${c.regressed}, reproPasses=${c.reproPasses}, confirmedDefects=${c.refutations?.length ?? 0}, files=${(c.filesTouched || []).join(',')}`)
    .join('\n')}\n\n` +
    `Pick the SINGLE best fix. Prefer: correct + repro-passing + no surviving defect + the SMALLEST, least-invasive change. ` +
    `List any superior ideas from runners-up worth grafting (as suggestions — they are NOT in the chosen patch). ` +
    `Set testUnverified=true if no automated test confirmed the fix (${plan.testable ? 'this defect was testable' : 'this defect was NOT automatically testable'}). Give the winning variant number, rationale, and confidence. Do not rewrite the patch.`,
  { schema: FINAL_SCHEMA },
)
const winner = candidates.find((c) => c.variant === final.winner) || candidates[0]
const finalPatch = winner ? winner.patch : ''

// ---- optional: apply the winning patch to the working tree (only when apply:true) ----
let applied = null
if (doApply && finalPatch) {
  applied = await agent(
    `Apply this patch to the repo at ${repo} working tree, then run \`${testCmd}\` and confirm the suite is green. Use: write the patch to a temp file and \`git -C ${repo} apply --3way <file>\` (or \`patch -p1\`). Report whether it applied cleanly and the suite result. Do NOT commit.\n\nPATCH:\n${finalPatch}`,
    {
      schema: { type: 'object', properties: { appliedClean: { type: 'boolean' }, suiteGreen: { type: 'boolean' }, notes: { type: 'string' } }, required: ['appliedClean'] },
      phase: 'Synthesize', label: 'apply',
    },
  )
  log(`Applied to working tree: clean=${applied.appliedClean} green=${applied.suiteGreen}`)
}

// ---- cleanup: remove the per-variant worktrees (best-effort) ----
const wts = fixes.map((f) => f.worktree).filter(Boolean)
if (wts.length) {
  await agent(
    `Best-effort cleanup: for each path, run \`git -C ${repo} worktree remove --force <path>\`; then \`git -C ${repo} worktree prune\`. Ignore errors. Paths:\n${wts.join('\n')}\nReturn a one-line summary.`,
    { schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] }, phase: 'Synthesize', label: 'cleanup' },
  )
}

return {
  repo,
  gap,
  verifier: VR.who,
  baseline: { green: baseline.green, passing: baseline.passing, total: baseline.total, testCommand: testCmd },
  plan: { bugSpec: plan.bugSpec, testable: plan.testable, strategies: plan.strategies.map((s) => s.name) },
  fixes: fixes.map((f) => ({ variant: f.variant, strategy: f.strategy, regressed: f.regressed, reproPasses: f.reproPasses, linesChanged: f.linesChanged })),
  verified: verified.filter(Boolean).map((v) => ({ variant: v.variant, refuted: v.refuted, confirmedDefects: v.refutations.length })),
  survivors: survivors.map((s) => s.variant),
  final: { winner: final.winner, rationale: final.rationale, confidence: final.confidence, testUnverified: final.testUnverified, graftedIdeas: final.graftedIdeas, reviewNotes: final.reviewNotes },
  patch: finalPatch,
  applied: doApply ? applied : null,
  note: doApply ? 'Patch applied to the working tree (not committed). Review `git diff` before committing.' : 'Diff-only: the working tree was NOT modified. Review `patch` and apply with `git apply`.',
}
