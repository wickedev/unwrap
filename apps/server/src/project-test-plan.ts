import type { StoredSession } from '@unwrap/protocol'
import type { Env } from './env'
import { aggregateProject, type ProjectDigest } from './project-aggregate'
import { analyzeTestCoverage, type TestCoverage } from './test-coverage'

export interface ProjectTestPlan {
  // Markdown body shown on the page.
  markdown: string
  model: string
  generatedAt: number
  usage: { promptTokens: number; candidatesTokens: number; totalTokens: number }
  // Cache key bits — invalidate when any of these change.
  sessionCount: number
  latestUploadedAt: number
  canonicalCount: number
  // Raw scenarios so a follow-up "generate spec from scenario" feature
  // can drive Gemini with the right context. Not surfaced in the markdown
  // verbatim — markdown is human-readable, scenarios are the structured
  // copy for tooling.
  scenarios: TestScenario[]
}

export interface TestScenario {
  name: string
  priority: 'high' | 'medium' | 'low'
  category: 'happy-path' | 'edge-case' | 'error-path' | 'regression' | 'accessibility' | 'performance'
  description: string
  // URLs / endpoints that justify this scenario (drawn from project digest).
  evidence: string[]
  // Suggested assertions to make the scenario meaningful.
  suggestedAssertions: string[]
  // Existing canonical spec name if there's already one covering this scenario.
  existingSpecName?: string
}

const TTL_SECONDS = 30 * 24 * 60 * 60

function planKey(email: string, host: string): string {
  return `test-plan:${email}:${host}`
}

export async function loadOrGenerateTestPlan(opts: {
  env: Env
  email: string
  host: string
  sessions: StoredSession[]
  canonicalCount: number
  forceRegenerate?: boolean
}): Promise<ProjectTestPlan> {
  const { env, email, host, sessions, canonicalCount } = opts
  const digest = aggregateProject(host, sessions)
  const coverage = analyzeTestCoverage(sessions)
  const key = planKey(email, host)

  if (!opts.forceRegenerate && env.SESSIONS) {
    const cached = (await env.SESSIONS.get(key, 'json').catch(() => null)) as ProjectTestPlan | null
    if (
      cached &&
      cached.sessionCount === digest.sessionCount &&
      cached.latestUploadedAt === digest.lastCapturedAt &&
      cached.canonicalCount === canonicalCount
    ) {
      return cached
    }
  }

  const plan = await callGeminiForTestPlan({ env, digest, coverage, canonicalCount })
  if (env.SESSIONS) {
    await env.SESSIONS.put(key, JSON.stringify(plan), { expirationTtl: TTL_SECONDS })
  }
  return plan
}

export async function readCachedTestPlan(env: Env, email: string, host: string): Promise<ProjectTestPlan | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(planKey(email, host), 'json').catch(() => null)) as ProjectTestPlan | null
}

async function callGeminiForTestPlan(opts: {
  env: Env
  digest: ProjectDigest
  coverage: TestCoverage
  canonicalCount: number
}): Promise<ProjectTestPlan> {
  const { env, digest, coverage, canonicalCount } = opts
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured')
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash'

  const prompt = buildPrompt(digest, coverage, canonicalCount)

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 4096 },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        required: ['scenarios', 'rationale'],
        properties: {
          rationale: { type: 'string', description: 'One short paragraph: what you prioritized and why, given the captured surface and existing coverage. Audience: a tech lead deciding which tests to write first.' },
          scenarios: {
            type: 'array',
            description: 'Prioritized list of distinct test scenarios. Aim for 8–15. Skip anything already well-covered by canonical tests.',
            items: {
              type: 'object',
              required: ['name', 'priority', 'category', 'description', 'evidence', 'suggested_assertions'],
              properties: {
                name: { type: 'string', description: 'Short imperative name, kebab/title case. Example: "create-and-edit-project", "delete-with-pending-changes-confirmation".' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                category: { type: 'string', enum: ['happy-path', 'edge-case', 'error-path', 'regression', 'accessibility', 'performance'] },
                description: { type: 'string', description: 'Plain-language scenario walkthrough. What the user does, what they should see, what should happen on the network. Cite specific URLs / endpoints / GraphQL ops.' },
                evidence: { type: 'array', items: { type: 'string' }, description: 'Routes / endpoints / GraphQL ops drawn directly from the project surface that this scenario exercises.' },
                suggested_assertions: { type: 'array', items: { type: 'string' }, description: 'Specific Playwright-flavored assertions. Examples: "expect new project to appear in /api/projects response after POST", "expect heading to be \\"Settings\\" on /settings page".' },
                existing_spec_name: { type: 'string', description: 'If the scenario is already covered by a canonical spec, name it. Otherwise omit.' },
              },
            },
          },
        },
      },
    },
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    throw new Error(`Gemini API ${resp.status}: ${(await resp.text()).slice(0, 500)}`)
  }
  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    promptFeedback?: { blockReason?: string }
  }
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`)
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new Error('Gemini returned no text')

  let parsed: PlanJson
  try {
    parsed = JSON.parse(text) as PlanJson
  } catch {
    throw new Error(`Could not parse Gemini JSON: ${text.slice(0, 200)}`)
  }

  const scenarios: TestScenario[] = (parsed.scenarios ?? []).map((s) => ({
    name: s.name,
    priority: s.priority,
    category: s.category,
    description: s.description,
    evidence: s.evidence ?? [],
    suggestedAssertions: s.suggested_assertions ?? [],
    ...(s.existing_spec_name ? { existingSpecName: s.existing_spec_name } : {}),
  }))

  return {
    markdown: renderMarkdown(parsed.rationale ?? '', scenarios),
    model,
    generatedAt: Date.now(),
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      candidatesTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
    sessionCount: digest.sessionCount,
    latestUploadedAt: digest.lastCapturedAt,
    canonicalCount,
    scenarios,
  }
}

interface PlanJson {
  rationale?: string
  scenarios?: {
    name: string
    priority: 'high' | 'medium' | 'low'
    category: TestScenario['category']
    description: string
    evidence?: string[]
    suggested_assertions?: string[]
    existing_spec_name?: string
  }[]
}

const SYSTEM_INSTRUCTION = `You are a senior QA engineer building a test plan for a web service, using captured user-flow data from an observability tool called Unwrap.

Your job: propose a prioritized list of Playwright test scenarios that should be written for this service. Inputs are:
  - the project's known surface (routes, REST endpoints with status histograms, GraphQL operations)
  - the project's existing test coverage (which routes/endpoints already have specs)
  - the canonical tests already curated for the project (skip scenarios already covered)

Hard rules:
  - Every scenario MUST cite specific evidence from the inputs — URLs, endpoint paths, GraphQL operation names, error patterns. No generic test ideas.
  - Prioritize: high = user-facing critical flow (auth, checkout, primary create/delete), medium = important secondary flow, low = nice to have.
  - Skip scenarios already well-covered by canonical tests. If you mention one, note it as existing_spec_name.
  - Bias toward FEWER, HIGH-VALUE scenarios. Aim for 8–15 total.
  - Assertions must be specific and Playwright-flavored. "Expect /api/projects POST to return 201 with the new project id" not "verify creation works".
  - Include at least one accessibility scenario and one performance/regression scenario if the data warrants it.

Return ONLY a JSON object matching the schema. No markdown fences.`

function buildPrompt(digest: ProjectDigest, coverage: TestCoverage, canonicalCount: number): string {
  const parts: string[] = []
  parts.push(`# Service: ${digest.host}`)
  parts.push(`Captured from ${digest.sessionCount} sessions. ${coverage.specs.length} generated Playwright specs exist; ${canonicalCount} marked canonical.`)
  parts.push('')

  parts.push('## Existing canonical coverage')
  parts.push('')
  if (coverage.routesCoveredCount === 0) {
    parts.push('Nothing covered yet — start from scratch.')
  } else {
    parts.push(`- ${coverage.routesCoveredCount}/${coverage.routesTotalCount} routes covered by ≥1 spec`)
    parts.push(`- ${coverage.endpointsCoveredCount}/${coverage.endpointsTotalCount} endpoints transitively covered`)
    parts.push('')
    parts.push('Covered routes:')
    for (const r of coverage.routes.filter((r) => r.coveringSpecs.length > 0).slice(0, 30)) {
      parts.push(`- ${r.normalizedPath}`)
    }
  }
  parts.push('')

  parts.push('## Untested routes — sorted by traffic')
  parts.push('')
  for (const r of coverage.routes.filter((r) => r.coveringSpecs.length === 0).slice(0, 30)) {
    parts.push(`- ${r.normalizedPath} (${r.visitCount} visits, ${r.sessionCount} session${r.sessionCount === 1 ? '' : 's'})`)
  }
  parts.push('')

  parts.push('## Untested endpoints — sorted by call volume')
  parts.push('')
  for (const e of coverage.endpoints.filter((e) => e.coveringSpecs.length === 0).slice(0, 30)) {
    parts.push(`- ${e.method} ${e.normalizedPath} (${e.callCount} calls)`)
  }
  parts.push('')

  parts.push('## REST endpoints with status histograms (any non-2xx is a hint at error-path tests)')
  parts.push('')
  for (const e of digest.endpoints.filter((e) => !e.graphql).slice(0, 40)) {
    const statuses = Object.entries(e.statuses).sort(([a], [b]) => Number(a) - Number(b)).map(([s, n]) => `${s}×${n}`).join(' ')
    parts.push(`- ${e.method} ${e.normalizedPath} — ${statuses}`)
  }
  parts.push('')

  if (digest.graphqlOps.length > 0) {
    parts.push('## GraphQL operations')
    parts.push('')
    for (const op of digest.graphqlOps.slice(0, 30)) {
      parts.push(`- ${op.operationType} ${op.name} (${op.callCount} calls) — returns ${op.typenames.join(', ') || '(no typenames seen)'}`)
    }
    parts.push('')
  }

  parts.push('Generate the test plan now. Be specific, cite evidence, skip what canonical specs already cover.')
  return parts.join('\n')
}

function renderMarkdown(rationale: string, scenarios: TestScenario[]): string {
  const lines: string[] = []
  if (rationale) {
    lines.push('## Rationale')
    lines.push('')
    lines.push(rationale)
    lines.push('')
  }

  // Group by priority.
  const byPrio: Record<TestScenario['priority'], TestScenario[]> = { high: [], medium: [], low: [] }
  for (const s of scenarios) byPrio[s.priority].push(s)

  const PRIO_TITLE: Record<TestScenario['priority'], string> = {
    high: '🔴 High priority',
    medium: '🟡 Medium priority',
    low: '⚪ Low priority',
  }

  for (const p of ['high', 'medium', 'low'] as TestScenario['priority'][]) {
    const list = byPrio[p]
    if (list.length === 0) continue
    lines.push(`## ${PRIO_TITLE[p]} (${list.length})`)
    lines.push('')
    for (const s of list) {
      lines.push(`### ${s.name}`)
      lines.push(`*${s.category}*${s.existingSpecName ? ` · already covered by canonical: \`${s.existingSpecName}\`` : ''}`)
      lines.push('')
      lines.push(s.description)
      lines.push('')
      if (s.evidence.length > 0) {
        lines.push('**Evidence:**')
        for (const e of s.evidence) lines.push(`- \`${e}\``)
        lines.push('')
      }
      if (s.suggestedAssertions.length > 0) {
        lines.push('**Suggested assertions:**')
        for (const a of s.suggestedAssertions) lines.push(`- ${a}`)
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}
