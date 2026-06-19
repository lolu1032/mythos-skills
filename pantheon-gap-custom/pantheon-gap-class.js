export const meta = {
  name: 'pantheon-gap-class',
  description: 'Multi-agent gap analysis & feedback review: map the project -> probe each dimension for gaps -> adversarially confirm each gap -> synthesize a prioritized report',
  phases: [
    { title: 'Map', detail: 'Scout the project: stated purpose, stack, maturity, and which dimensions to audit' },
    { title: 'Probe', detail: 'One agent per dimension hunts for gaps with file-level evidence' },
    { title: 'Confirm', detail: 'Skeptical reviewers try to dismiss each gap; false positives are dropped' },
    { title: 'Synthesize', detail: 'Judge dedups, prioritizes by impact x effort, writes the report' },
  ],
}

// NOTE: the Workflow tool delivers `args` as a JSON STRING (not a parsed object).
// Parse defensively so this works whether args is a string, an object, or absent.
let A = {}
if (typeof args === 'string') { try { A = args ? JSON.parse(args) : {} } catch (e) { A = {} } }
else if (args && typeof args === 'object') { A = args }

const target = A.target ?? A.workdir ?? '.'         // absolute path to the project being reviewed
const focus = A.focus ?? null                       // optional: dimension/area to emphasize
const maxDims = A.maxDimensions ?? 6                // how many dimensions to probe
const V = A.verifiers ?? 2                          // skeptical reviewers per candidate gap
const crossVerify = A.crossModelVerify ?? false    // true => Codex/GPT-5.5 runs the confirm step
const dimensionsOverride = Array.isArray(A.dimensions) ? A.dimensions : null

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    projectType: { type: 'string', description: 'What kind of project this is (CLI, web app, library, ...)' },
    statedPurpose: { type: 'string', description: 'What the project claims to do, per README/docs' },
    stack: { type: 'array', items: { type: 'string' } },
    maturity: { type: 'string', enum: ['prototype', 'mvp', 'production', 'unknown'] },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          why: { type: 'string', description: 'Why this dimension matters for THIS project' },
        },
        required: ['key', 'why'],
      },
      description: 'The dimensions worth auditing for this specific project, most important first',
    },
  },
  required: ['statedPurpose', 'dimensions'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    dimension: { type: 'string' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          evidence: { type: 'string', description: 'file:line or a concrete observation from the actual code' },
          impact: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['title', 'severity', 'evidence', 'suggestion'],
      },
    },
  },
  required: ['dimension', 'gaps'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    valid: { type: 'boolean', description: 'true ONLY if the gap genuinely holds up under inspection' },
    reason: { type: 'string' },
    adjustedSeverity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  },
  required: ['valid', 'reason'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: "Short read on the project's current state" },
    highestLeverage: { type: 'string', description: 'The single most important thing to fix next' },
    topGaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dimension: { type: 'string' },
          severity: { type: 'string' },
          impact: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['title', 'severity', 'suggestion'],
      },
    },
    quickWins: { type: 'array', items: { type: 'string' }, description: 'Cheap, high-value fixes' },
    overallAssessment: { type: 'string' },
  },
  required: ['summary', 'highestLeverage', 'topGaps'],
}

// ---- Phase 1: MAP — scout the project and choose the dimensions worth auditing ----
phase('Map')
const profile = await agent(
  `You are the SCOUT in a Pantheon gap-analysis harness. Target project: ${target}\n\n` +
    `Survey it: read the README/docs, the directory structure, package manifests, entry points, tests, and CI config. ` +
    `Determine what the project IS, its STATED PURPOSE (what it claims to do), its stack, and its maturity. ` +
    `Then choose up to ${maxDims} dimensions most worth auditing for GAPS in THIS specific project, most important first.\n` +
    `Dimension menu (pick from these and/or add project-specific ones): product-completeness, correctness-robustness, ` +
    `testing, security, docs-onboarding, architecture-maintainability, dx-api, performance-scalability, ops-observability.` +
    (focus ? `\nThe user wants extra emphasis on: ${focus}.` : ''),
  { schema: PROFILE_SCHEMA },
)
const dims = dimensionsOverride
  ? dimensionsOverride.map((k) => ({ key: k, why: 'user-specified' }))
  : profile.dimensions.slice(0, maxDims)
log(`Scouted (${profile.maturity ?? 'unknown'}): "${(profile.statedPurpose ?? 'project').slice(0, 60)}". Auditing ${dims.length}: ${dims.map((d) => d.key).join(', ')}`)

// ---- Phases 2+3: PROBE each dimension, then CONFIRM each gap adversarially (pipelined) ----
// pantheon-gap-custom: the adversarial-confirm step runs on a USER-SELECTABLE model (`verifier` arg).
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
log(`Adversarial confirm model: ${VR.who}`)
// One skeptic's agent() promise, routed to the chosen model. `meta` = { phase, label }.
function verifierAgent(promptCore, meta) {
  if (VR.mode === 'http') {
    return agent(
      `You are a DRIVER. Delegate this gap confirmation to an INDEPENDENT external model (${VR.who}) by calling its OpenAI-compatible chat API DIRECTLY (not via codex), then relay ITS verdict. Do NOT judge the gap yourself.\n\n` +
        `Steps (use Bash; never print the key):\n` +
        `1. Load the key: [ -f ~/.pantheon/env ] && . ~/.pantheon/env   (sets $${VR.envKey}).\n` +
        `2. Using python3 so the prompt is safely JSON-escaped, write a request-body file with: model="${VR.model}", temperature=0, messages=[{"role":"user","content": THE REVIEW PROMPT BELOW, followed by "Inspect the actual code, then output ONLY one compact JSON object with keys valid(boolean), reason(string), adjustedSeverity(one of low|medium|high|critical)."}].\n` +
        `3. POST it: curl -s -w "\\n%{http_code}" ${VR.baseUrl}/chat/completions -H "Authorization: Bearer $${VR.envKey}" -H "Content-Type: application/json" -d @BODYFILE\n` +
        `4. From the JSON response take choices[0].message.content, extract the verdict JSON object it contains, and return THAT as your structured output (unchanged).\n` +
        `5. If $${VR.envKey} is empty, the HTTP status is not 200, or no JSON comes back, return valid=true, reason="external verifier ${VR.who} unavailable: <short error> — gap KEPT unconfirmed, verify manually", adjustedSeverity="medium". Never fabricate a dismissal.\n\n` +
        `REVIEW PROMPT <<<\n${promptCore}\n>>>`,
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  if (VR.mode === 'codex') {
    return agent(
      `You are a DRIVER. Delegate this gap confirmation to an INDEPENDENT external model (${VR.who}) via the codex CLI, then relay ITS verdict. Do NOT judge the gap yourself.\n\n` +
        `Steps (use Bash; create temp files with mktemp):\n` +
        `1. Write this JSON Schema to a file $SCHEMA:\n${JSON.stringify(VERDICT_SCHEMA)}\n` +
        `2. Write the REVIEW PROMPT (between <<< >>> below) to a file $PROMPT.\n` +
        `3. Load saved API keys (if any), then run EXACTLY (OUT = another mktemp file). Do NOT print the keys:\n   [ -f ~/.pantheon/env ] && . ~/.pantheon/env;  codex exec --skip-git-repo-check --ephemeral --sandbox read-only -C ${target} ${VR.codexArgs.join(' ')} --output-schema "$SCHEMA" -o "$OUT" < "$PROMPT"\n   If codex rejects --output-schema for this provider, drop that flag and instead extract the JSON object the model prints to stdout.\n` +
        `4. Read $OUT (or the parsed stdout JSON) and return it as your structured verdict, unchanged.\n` +
        `If codex is missing / the *_API_KEY is unset / the model is unreachable / no JSON is produced, return {"valid":true,"reason":"external verifier ${VR.who} unavailable: <short error> — gap KEPT unconfirmed, verify manually","adjustedSeverity":"medium"} — never fabricate a dismissal.\n\n` +
        `REVIEW PROMPT <<<\n${promptCore}\n\nInspect the actual code, then output ONLY the verdict JSON.\n>>>`,
      { schema: VERDICT_SCHEMA, ...meta },
    )
  }
  const extra = VR.mode === 'agent' ? { agentType: VR.agentType } : VR.model ? { model: VR.model } : {}
  return agent(promptCore, { schema: VERDICT_SCHEMA, ...meta, ...extra })
}

const reviewed = await pipeline(
  dims,
  // Stage 1 — probe one dimension for concrete, evidence-backed gaps
  (d) =>
    agent(
      `You are GAP-PROBE for the "${d.key}" dimension in a Pantheon gap-analysis harness. Target project: ${target}\n` +
        `Project purpose: ${profile.statedPurpose}\nWhy this dimension matters here: ${d.why}\n\n` +
        `Hunt for concrete GAPS — things that are MISSING, incomplete, or weak in this dimension. ` +
        `For each gap give a short title, a severity, EVIDENCE (cite a file:line or a concrete observation — read the actual code, do NOT speculate), the impact, and a concrete suggestion. ` +
        `Prefer 3-8 real, high-signal gaps over a long noisy list. If this dimension is genuinely solid, return an empty gaps array.`,
      { schema: FINDINGS_SCHEMA, phase: 'Probe', label: `probe:${d.key}` },
    ),
  // Stage 2 — for each gap, V skeptical reviewers try to DISMISS it
  (review) =>
    parallel(
      (review?.gaps ?? []).map((g) => () =>
        parallel(
          Array.from({ length: V }, (_, k) => () =>
            verifierAgent(
              `You are a SKEPTICAL REVIEWER (${k}) in a Pantheon gap-analysis harness. A probe claims this is a gap in project ${target}:\n\n` +
                `DIMENSION: ${review.dimension}\nGAP: ${g.title}\nSEVERITY: ${g.severity}\nEVIDENCE: ${g.evidence}\nSUGGESTION: ${g.suggestion}\n\n` +
                `Your job is to DISMISS it. Check the ACTUAL code: is it already handled elsewhere, out of scope for the project's stated purpose, a false positive, or trivial? ` +
                `Set valid=false unless the gap genuinely holds up under inspection. If it holds, set valid=true with an adjustedSeverity you would defend.`,
              { phase: 'Confirm', label: `confirm:${review.dimension}.${k}` },
            ),
          ),
        ).then((vs) => {
          const verdicts = vs.filter(Boolean)
          const kept = verdicts.filter((v) => v.valid).length >= Math.ceil(V / 2)
          const sev = verdicts.filter((v) => v.valid && v.adjustedSeverity).map((v) => v.adjustedSeverity)[0]
          return { ...g, dimension: review.dimension, kept, verdicts: verdicts.length, adjustedSeverity: sev ?? g.severity }
        }),
      ),
    ),
)

const allGaps = reviewed.filter(Boolean).flat().filter(Boolean)
const confirmed = allGaps.filter((g) => g.kept)
log(`Confirmed ${confirmed.length}/${allGaps.length} gaps after adversarial review`)

// ---- Phase 4: SYNTHESIZE — dedup, prioritize, write the feedback report ----
phase('Synthesize')
if (!confirmed.length) {
  return {
    target,
    profile: { purpose: profile.statedPurpose, stack: profile.stack, maturity: profile.maturity, dimensions: dims.map((d) => d.key) },
    gapsFound: allGaps.length,
    gapsConfirmed: 0,
    report: {
      summary: 'No high-confidence gaps survived adversarial review across the audited dimensions.',
      highestLeverage: 'Nothing critical surfaced. Widen the dimension set or deepen the probe if you want more coverage.',
      topGaps: [],
      quickWins: [],
      overallAssessment: 'The audited dimensions look solid, or the project is too early/empty to probe meaningfully.',
    },
  }
}

const report = await agent(
  `You are the JUDGE/SYNTHESIZER in a Pantheon gap-analysis harness for project ${target} (purpose: ${profile.statedPurpose}). ` +
    `Here are the gaps that SURVIVED adversarial review:\n` +
    confirmed
      .map((g, i) => `${i + 1}. [${g.dimension} | ${g.adjustedSeverity}] ${g.title} — ${g.impact ?? ''} (evidence: ${g.evidence}; fix: ${g.suggestion})`)
      .join('\n') +
    `\n\nDeduplicate overlapping gaps, then produce the final feedback review: a short summary of the project's state, the TOP gaps prioritized by impact x effort, a list of quick wins (cheap high-value fixes), and the single HIGHEST-LEVERAGE thing to fix next. Be direct and concrete — this is feedback for the author.`,
  { schema: REPORT_SCHEMA },
)

return {
  target,
  profile: { purpose: profile.statedPurpose, stack: profile.stack, maturity: profile.maturity, dimensions: dims.map((d) => d.key) },
  probed: dims.map((d) => d.key),
  gapsFound: allGaps.length,
  gapsConfirmed: confirmed.length,
  report,
}
