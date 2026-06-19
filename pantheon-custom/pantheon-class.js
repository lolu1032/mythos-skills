export const meta = {
  name: 'pantheon-class',
  description: 'Wrap Opus 4.8 in a Pantheon harness: plan -> parallel variants -> test-gate self-correction -> adversarial verify -> synthesize',
  phases: [
    { title: 'Plan', detail: 'Decompose task into spec, test plan, and N strategies' },
    { title: 'Implement', detail: 'N variants in parallel; each runs its own tests and self-corrects (T1 loop)' },
    { title: 'Verify', detail: 'Independent adversarial reviewers try to break each green variant' },
    { title: 'Synthesize', detail: 'Judge picks the winner and grafts the best ideas' },
  ],
}

// NOTE: the Workflow tool delivers `args` as a JSON STRING (not a parsed object).
// Parse defensively so this works whether args is a string, an object, or absent.
let A = {}
if (typeof args === 'string') { try { A = args ? JSON.parse(args) : {} } catch (e) { A = {} } }
else if (args && typeof args === 'object') { A = args }

const task = A.task ?? 'Implement a token-bucket rate limiter in pure Python 3 (standard library only). API: RateLimiter(capacity:int, refill_rate_per_sec:float) with method allow(now:float, tokens:int=1)->bool that consumes tokens if available at time now and returns True, else returns False without consuming. Tokens refill continuously at refill_rate_per_sec up to capacity. now is monotonic non-decreasing across calls.'
const workdir = A.workdir ?? '/tmp/pantheon-demo'
const lang = A.lang ?? 'pure Python 3 (standard library only); put the test file as test_limiter.py runnable with `python3 -m unittest`'
const N = A.variants ?? 3
const V = A.verifiers ?? 2
const crossVerify = A.crossModelVerify ?? false // true => Codex/GPT-5.5 does the adversarial check

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    spec: { type: 'string', description: 'Tight restatement of the requirement' },
    testPlan: { type: 'array', items: { type: 'string' }, description: 'Concrete test cases that define correctness' },
    strategies: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, approach: { type: 'string' } },
        required: ['name', 'approach'],
      },
      description: 'Distinct implementation strategies, one per variant',
    },
  },
  required: ['spec', 'testPlan', 'strategies'],
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'number' },
    strategy: { type: 'string' },
    path: { type: 'string' },
    iterations: { type: 'number' },
    testsTotal: { type: 'number' },
    testsPassing: { type: 'number' },
    allTestsPass: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['variant', 'path', 'allTestsPass', 'testsPassing', 'testsTotal'],
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
    graftedIdeas: { type: 'array', items: { type: 'string' } },
    finalPath: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['winner', 'rationale', 'finalPath'],
}

// ---- Phase 1: PLAN (test-time compute: think the spec + tests out first) ----
phase('Plan')
const plan = await agent(
  `You are the PLANNER in a Pantheon harness. Task:\n\n${task}\n\nProduce: (1) a tight spec, (2) a concrete test plan of edge cases that DEFINE correctness, and (3) exactly ${N} DISTINCT implementation strategies. Language/runtime constraint: ${lang}.`,
  { schema: PLAN_SCHEMA },
)
log(`Plan ready: ${plan.strategies.length} strategies, ${plan.testPlan.length} test cases`)

// ---- Phase 2: IMPLEMENT + self-correct against tests (T1 tool-integrated verification) ----
const strategies = plan.strategies.slice(0, N).map((s, i) => ({ s, i }))
const built = await parallel(
  strategies.map(({ s, i }) => () =>
    agent(
      `You are BUILDER #${i} in a Pantheon harness. Implement this task using ONLY the strategy below; do not copy the other strategies.\n\nTASK:\n${task}\n\nSTRATEGY: ${s.name} — ${s.approach}\n\nLanguage/runtime: ${lang}\n\nSpec:\n${plan.spec}\nTest plan (cover EVERY case):\n- ${plan.testPlan.join('\n- ')}\n\nWORKDIR: create ${workdir}/variant-${i}. Write the implementation file AND the test file covering every case above. Then RUN the test command for this stack inside that dir. T1 SELF-CORRECTION LOOP: if any test fails, read the error, fix the implementation (not the tests, unless a test is genuinely wrong), and re-run. Repeat up to 5 iterations. Stop when all tests pass or after 5. Report variant ${i}, the absolute path, iterations used, tests total/passing, and whether all pass.`,
      { schema: BUILD_SCHEMA, phase: 'Implement', label: `impl:v${i} (${s.name})` },
    ),
  ),
)
const ok = built.filter(Boolean)
if (!ok.length) {
  log('No variant produced a runnable build; aborting.')
  return { task, plan, built: [], error: 'no runnable builds' }
}
const green = ok.filter((b) => b.allTestsPass)
log(`Built ${ok.length}/${N}; green (all tests pass): ${green.length}`)

// ---- Phase 3: ADVERSARIAL VERIFY — independent reviewers try to BREAK each candidate ----
const pool = green.length
  ? green
  : ok.slice().sort((a, b) => b.testsPassing / b.testsTotal - a.testsPassing / a.testsTotal).slice(0, 1)
// pantheon-custom: the adversarial-verify step runs on a USER-SELECTABLE model (`verifier` arg).
//  - Claude family (opus/sonnet/haiku/fable) -> { model }; omitted/'claude' -> default Claude.
//  - 'codex'/'gpt' -> the installed codex:codex-rescue plugin agent (codex's default model).
//  - ANY OTHER external/local AI is driven through `codex exec` (codex is itself a multi-provider
//    router): 'ollama:<model>' / 'lmstudio:<model>' (local, no key), 'profile:<name>' (a codex
//    config profile), 'model:<name>' (a codex model id), or a built-in alias below
//    (deepseek/qwen/kimi — needs the matching *_API_KEY env var). crossModelVerify:true stays = codex.
// Provider catalog mirrored from OpenClaw (docs.openclaw.ai/concepts/model-providers): the
// OpenAI/Responses-compatible cloud + local-HTTP providers `codex exec` can route to. `envKey` is the
// NAME of the API-key env var (no secret). Extend/override at runtime via args.providers (same shape,
// e.g. fed from the repo's providers.json). First-party Claude / GPT-5.5 / Ollama are special-cased below.
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
// Cloud providers are called DIRECTLY via their OpenAI-compatible /chat/completions endpoint (curl),
// NOT through codex: codex 0.139.0 only speaks the Responses wire, which chat-only providers lack.
function httpDesc(provId, model) {
  const p = providers[provId]
  return { mode: 'http', baseUrl: p.baseUrl, envKey: p.envKey, model: model || p.defModel || (p.models && p.models[0]) || provId, who: provId + (model ? ' ' + model : '') }
}
// Map a `verifier` string to how the adversarial step runs. Accepts: '' / 'claude' (default Claude),
// a Claude tier, 'codex'/'gpt', an 'ollama:/lmstudio:/profile:/model:' form, a cloud alias
// (deepseek/qwen/kimi), or an OpenClaw-style 'provider/model-id' (anthropic/haiku, ollama/qwen2.5:7b,
// deepseek/deepseek-chat, openrouter/qwen/..., openai/gpt-5.5).
function resolveVerifier(v, crossLegacy) {
  const raw = typeof v === 'string' ? v.trim() : ''
  const m = raw.toLowerCase()
  const CLAUDE = ['opus', 'sonnet', 'haiku', 'fable']
  if (!m || m === 'claude' || m === 'default') return crossLegacy ? { mode: 'agent', agentType: 'codex:codex-rescue', who: 'GPT-5.5 (Codex)' } : { mode: 'claude', who: 'Claude (default)' }
  if (CLAUDE.includes(m)) return { mode: 'claude', model: m, who: 'Claude ' + m }
  if (m === 'codex' || m === 'gpt' || m === 'gpt-5.5' || m === 'gpt5.5' || m === 'openai') return { mode: 'agent', agentType: 'codex:codex-rescue', who: 'GPT-5.5 (Codex)' }
  // OpenClaw-style provider/model-id (split on FIRST slash)
  if (raw.includes('/')) {
    const s = raw.indexOf('/'); let prov = raw.slice(0, s).toLowerCase(); const model = raw.slice(s + 1)
    if (prov === 'anthropic' || prov === 'claude') return CLAUDE.includes(model.toLowerCase()) ? { mode: 'claude', model: model.toLowerCase(), who: 'Claude ' + model } : { mode: 'claude', who: 'Claude' }
    if (prov === 'ollama' || prov === 'lmstudio') return { mode: 'codex', codexArgs: ['--oss', '--local-provider', prov, '-m', model], who: prov + ' ' + model + ' (local)' }
    if (prov === 'openai' || prov === 'gpt') return { mode: 'codex', codexArgs: ['-m', model], who: model }
    if (ALIASES[prov]) prov = ALIASES[prov]
    if (providers[prov] && providers[prov].baseUrl) return httpDesc(prov, model)
    return { mode: 'codex', codexArgs: ['-c', `model_provider=${prov}`, '-m', model], who: raw }
  }
  // prefix forms
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
// One reviewer's agent() promise, routed to the chosen model. `meta` = { phase, label }.
function verifierAgent(promptCore, meta) {
  if (VR.mode === 'http') {
    return agent(
      `You are a DRIVER. Delegate this adversarial review to an INDEPENDENT external model (${VR.who}) by calling its OpenAI-compatible chat API DIRECTLY (not via codex), then relay ITS verdict. Do NOT judge the code yourself.\n\n` +
        `Steps (use Bash; never print the key):\n` +
        `1. Load the key: [ -f ~/.pantheon/env ] && . ~/.pantheon/env   (sets $${VR.envKey}).\n` +
        `2. Using python3 so the prompt is safely JSON-escaped, write a request-body file with: model="${VR.model}", temperature=0, messages=[{"role":"user","content": THE REVIEW PROMPT BELOW, followed by "Reason about the code, then output ONLY one compact JSON object with keys defectFound(boolean), severity(one of none|low|medium|high), description(string), failingCase(string)."}].\n` +
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
        `3. Load saved API keys (if any), then run EXACTLY (OUT = another mktemp file). Do NOT print the keys:\n   [ -f ~/.pantheon/env ] && . ~/.pantheon/env;  codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write -C ${workdir} ${VR.codexArgs.join(' ')} --output-schema "$SCHEMA" -o "$OUT" < "$PROMPT"\n   If codex rejects --output-schema for this provider, drop that flag and instead extract the JSON object the model prints to stdout.\n` +
        `4. Read $OUT (or the parsed stdout JSON) and return it as your structured verdict, unchanged.\n` +
        `If codex is missing / the *_API_KEY is unset / the model is unreachable / no JSON is produced, return {"defectFound":false,"severity":"none","description":"external verifier ${VR.who} unavailable: <short error>"} — never fabricate a defect.\n\n` +
        `REVIEW PROMPT <<<\n${promptCore}\n\nReason about the code, then output ONLY the verdict JSON.\n>>>`,
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  const extra = VR.mode === 'agent' ? { agentType: VR.agentType } : VR.model ? { model: VR.model } : {}
  return agent(promptCore, { schema: VERDICT_SCHEMA, ...meta, ...extra })
}
const verified = await parallel(
  pool.map((b) => () =>
    parallel(
      Array.from({ length: V }, (_, k) => () =>
        verifierAgent(
          `You are ADVERSARIAL REVIEWER ${k} for variant ${b.variant} at ${b.path}. Your job is to BREAK it, not praise it. Read the implementation, then try to construct an input that violates the spec (boundary/rounding/off-by-one/concurrency/empty/overflow as applicable). You MAY write a tiny extra script and run it to PROVE a failure. Set defectFound=false ONLY if you genuinely cannot break it. Return your verdict with severity and a failing case if found.`,
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

// ---- Phase 4: SYNTHESIZE — judge picks winner, grafts best ideas ----
phase('Synthesize')
const candidates = survivors.length ? survivors : verified.filter(Boolean)
const final = await agent(
  `You are the JUDGE/SYNTHESIZER in a Pantheon harness. Candidate implementations (all paths exist on disk):\n${candidates
    .map((c) => `- variant ${c.variant} (${c.strategy ?? 'n/a'}) at ${c.path}: ${c.testsPassing}/${c.testsTotal} tests pass; confirmed refutations=${c.refutations?.length ?? 0}`)
    .join('\n')}\n\nRead the winner and runners-up. Pick the single best variant. List any superior ideas from the others worth grafting in. Give the winner's absolute path as finalPath and your confidence. Do NOT rewrite files; just decide and explain.`,
  { schema: FINAL_SCHEMA },
)

return {
  task,
  plan: { spec: plan.spec, testCount: plan.testPlan.length, strategies: plan.strategies.map((s) => s.name) },
  built: ok.map((b) => ({ variant: b.variant, strategy: b.strategy, iterations: b.iterations, tests: `${b.testsPassing}/${b.testsTotal}`, allPass: b.allTestsPass })),
  green: green.map((g) => g.variant),
  verified: verified.filter(Boolean).map((v) => ({ variant: v.variant, refuted: v.refuted, confirmedRefutations: v.refutations.length })),
  survivors: survivors.map((s) => s.variant),
  final,
}
