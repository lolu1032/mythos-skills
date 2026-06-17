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
const verifyOpts = crossVerify ? { agentType: 'codex:codex-rescue' } : {}

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
            agent(
              `You are a SKEPTICAL REVIEWER (${k}) in a Pantheon gap-analysis harness. A probe claims this is a gap in project ${target}:\n\n` +
                `DIMENSION: ${review.dimension}\nGAP: ${g.title}\nSEVERITY: ${g.severity}\nEVIDENCE: ${g.evidence}\nSUGGESTION: ${g.suggestion}\n\n` +
                `Your job is to DISMISS it. Check the ACTUAL code: is it already handled elsewhere, out of scope for the project's stated purpose, a false positive, or trivial? ` +
                `Set valid=false unless the gap genuinely holds up under inspection. If it holds, set valid=true with an adjustedSeverity you would defend.`,
              { schema: VERDICT_SCHEMA, phase: 'Confirm', label: `confirm:${review.dimension}.${k}`, ...verifyOpts },
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
