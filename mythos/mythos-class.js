export const meta = {
  name: 'mythos-class',
  description: 'Wrap Opus 4.8 in a Mythos-class harness: plan -> parallel variants -> test-gate self-correction -> adversarial verify -> synthesize',
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
const workdir = A.workdir ?? '/tmp/mythos-demo'
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
  `You are the PLANNER in a Mythos-class harness. Task:\n\n${task}\n\nProduce: (1) a tight spec, (2) a concrete test plan of edge cases that DEFINE correctness, and (3) exactly ${N} DISTINCT implementation strategies. Language/runtime constraint: ${lang}.`,
  { schema: PLAN_SCHEMA },
)
log(`Plan ready: ${plan.strategies.length} strategies, ${plan.testPlan.length} test cases`)

// ---- Phase 2: IMPLEMENT + self-correct against tests (T1 tool-integrated verification) ----
const strategies = plan.strategies.slice(0, N).map((s, i) => ({ s, i }))
const built = await parallel(
  strategies.map(({ s, i }) => () =>
    agent(
      `You are BUILDER #${i} in a Mythos-class harness. Implement this task using ONLY the strategy below; do not copy the other strategies.\n\nTASK:\n${task}\n\nSTRATEGY: ${s.name} — ${s.approach}\n\nLanguage/runtime: ${lang}\n\nSpec:\n${plan.spec}\nTest plan (cover EVERY case):\n- ${plan.testPlan.join('\n- ')}\n\nWORKDIR: create ${workdir}/variant-${i}. Write the implementation file AND the test file covering every case above. Then RUN the test command for this stack inside that dir. T1 SELF-CORRECTION LOOP: if any test fails, read the error, fix the implementation (not the tests, unless a test is genuinely wrong), and re-run. Repeat up to 5 iterations. Stop when all tests pass or after 5. Report variant ${i}, the absolute path, iterations used, tests total/passing, and whether all pass.`,
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
const verifyOpts = crossVerify ? { agentType: 'codex:codex-rescue' } : {}
const verified = await parallel(
  pool.map((b) => () =>
    parallel(
      Array.from({ length: V }, (_, k) => () =>
        agent(
          `You are ADVERSARIAL REVIEWER ${k} for variant ${b.variant} at ${b.path}. Your job is to BREAK it, not praise it. Read the implementation, then try to construct an input that violates the spec (boundary/rounding/off-by-one/concurrency/empty/overflow as applicable). You MAY write a tiny extra script and run it to PROVE a failure. Set defectFound=false ONLY if you genuinely cannot break it. Return your verdict with severity and a failing case if found.`,
          { schema: VERDICT_SCHEMA, phase: 'Verify', label: `verify:v${b.variant}.${k}`, ...verifyOpts },
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
  `You are the JUDGE/SYNTHESIZER in a Mythos-class harness. Candidate implementations (all paths exist on disk):\n${candidates
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
