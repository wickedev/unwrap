import type { ScreenshotInline, StoredSession } from '@unwrap/protocol'
import type { Env } from './env'
import type { ProjectDigest, EndpointEntry } from './project-aggregate'
import { inferType } from './schema-infer'

export interface ProjectNarrative {
  markdown: string
  model: string
  generatedAt: number
  usage: { promptTokens: number; candidatesTokens: number; totalTokens: number }
  // Used as the cache key so a new upload invalidates the stored narrative.
  sessionCount: number
  latestUploadedAt: number
}

const NARRATIVE_TTL_SECONDS = 30 * 24 * 60 * 60

function narrativeKey(email: string, host: string): string {
  return `narrative:${email}:${host}`
}

// Tries the cached narrative first; if the cache miss or the cached
// narrative is for a stale set of sessions (digest's sessionCount or
// latestUploadedAt changed), regenerates. forceRegenerate skips the read.
export async function loadOrGenerateNarrative(opts: {
  env: Env
  email: string
  digest: ProjectDigest
  latestSession: StoredSession
  forceRegenerate?: boolean
}): Promise<ProjectNarrative> {
  const { env, email, digest, latestSession } = opts
  const key = narrativeKey(email, digest.host)

  if (!opts.forceRegenerate && env.SESSIONS) {
    const cached = await env.SESSIONS.get(key, 'json').catch(() => null)
    if (cached && typeof cached === 'object') {
      const n = cached as ProjectNarrative
      if (n.sessionCount === digest.sessionCount && n.latestUploadedAt === digest.lastCapturedAt) {
        return n
      }
    }
  }

  const narrative = await generateProjectNarrative({ env, digest, latestSession })
  if (env.SESSIONS) {
    await env.SESSIONS.put(key, JSON.stringify(narrative), { expirationTtl: NARRATIVE_TTL_SECONDS })
  }
  return narrative
}

async function generateProjectNarrative(opts: {
  env: Env
  digest: ProjectDigest
  latestSession: StoredSession
}): Promise<ProjectNarrative> {
  const { env, digest, latestSession } = opts
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured')
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash'

  const screenshots = pickRepresentativeScreenshots(latestSession, 3)
  const promptText = buildPromptText(digest, latestSession)

  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = []
  parts.push({ text: promptText })
  for (const shot of screenshots) {
    parts.push({ text: `Screenshot at ts=${shot.ts} (reason=${shot.reason}):` })
    parts.push({ inlineData: { mimeType: shot.mediaType, data: shot.dataBase64 } })
  }

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      // Allow some thinking — narrative quality benefits, but cap so output
      // can't be starved.
      thinkingConfig: { thinkingBudget: 4096 },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        required: ['service_type', 'one_liner', 'user_journeys', 'tech_stack_hints', 'architecture_observations', 'reverse_engineering_checklist'],
        properties: {
          service_type: { type: 'string', description: 'Best guess at what kind of product this is (e.g., "B2B analytics dashboard", "consumer photo sharing app"). One short phrase.' },
          one_liner: { type: 'string', description: 'One sentence describing what the service does and for whom.' },
          target_audience: { type: 'string', description: 'Best guess at who the primary users are. May be empty if uncertain.' },
          user_journeys: {
            type: 'array',
            description: 'Distinct user flows observed in the captures, ordered by apparent importance.',
            items: {
              type: 'object',
              required: ['name', 'description'],
              properties: {
                name: { type: 'string', description: 'Short kebab/title-case name of the flow.' },
                description: { type: 'string', description: 'What the user did, what the system did in response, and what the apparent goal was. Reference specific URLs and API calls where evident.' },
              },
            },
          },
          tech_stack_hints: {
            type: 'array',
            description: 'Specific technologies you can infer from URLs, response shapes, GraphQL presence, asset filenames, etc. Each hint must cite the evidence.',
            items: {
              type: 'object',
              required: ['hint', 'evidence'],
              properties: {
                hint: { type: 'string', description: 'The inference (e.g., "Next.js frontend", "Hasura GraphQL backend").' },
                evidence: { type: 'string', description: 'Specific URLs, headers, asset filenames, or response patterns that support the hint.' },
              },
            },
          },
          architecture_observations: { type: 'string', description: 'Notable architectural patterns observed: monolith vs microservices hints, REST vs GraphQL split, auth model, state management style. 1-3 paragraphs.' },
          reverse_engineering_checklist: {
            type: 'array',
            description: 'Concrete next steps a reverse engineer should investigate to fully understand or recreate this service. Each item should be actionable.',
            items: { type: 'string' },
          },
          uncertainty: { type: 'string', description: 'Honest acknowledgment of what you could NOT determine from the captures and why. May be empty.' },
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
    const text = await resp.text()
    throw new Error(`Gemini API ${resp.status}: ${text.slice(0, 500)}`)
  }
  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    promptFeedback?: { blockReason?: string }
  }
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`)
  }
  const candidate = data.candidates?.[0]
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new Error('Gemini returned no text content')

  let parsed: NarrativeJson
  try {
    parsed = JSON.parse(text) as NarrativeJson
  } catch {
    throw new Error(`Failed to parse Gemini response JSON: ${text.slice(0, 200)}`)
  }

  return {
    markdown: renderNarrativeMarkdown(digest, parsed),
    model,
    generatedAt: Date.now(),
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      candidatesTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
    sessionCount: digest.sessionCount,
    latestUploadedAt: digest.lastCapturedAt,
  }
}

interface NarrativeJson {
  service_type?: string
  one_liner?: string
  target_audience?: string
  user_journeys?: { name: string; description: string }[]
  tech_stack_hints?: { hint: string; evidence: string }[]
  architecture_observations?: string
  reverse_engineering_checklist?: string[]
  uncertainty?: string
}

const SYSTEM_INSTRUCTION = `You are a senior reverse-engineer analyzing a web service from captured browser sessions. Your job is to produce a service-brief document that helps another engineer quickly understand what this service does, how it appears to be built, and what to investigate next.

Hard rules:
- Be specific. Avoid generic SaaS-marketing prose. Every claim must be tied to evidence visible in the inputs (a URL, an API path, a screenshot, a response shape, a GraphQL operation).
- When you don't know, say so in the uncertainty field. Do not invent technology names you don't have evidence for.
- Use the captured screenshots as primary evidence of what the user-facing product looks like. Use the API surface as primary evidence of what the system does.
- Keep prose tight. Prefer concrete observations over hedging language.
- Don't speculate about business model, pricing, company strategy, or anything not visible in the captures.

Return ONLY a JSON object matching the response schema. Do not wrap it in markdown fences.`

function buildPromptText(digest: ProjectDigest, latestSession: StoredSession): string {
  const parts: string[] = []

  parts.push(`# Service to analyze: ${digest.host}`)
  parts.push('')
  parts.push(`Captured by an extension during ${digest.sessionCount} browser session${digest.sessionCount === 1 ? '' : 's'} of real user interaction. Goal: understand and reverse-engineer this service.`)
  parts.push('')
  parts.push(`Aggregated stats: ${digest.routes.length} unique pages visited · ${digest.endpoints.filter((e) => !e.graphql).length} REST endpoints · ${digest.graphqlOps.length} GraphQL operations · ${digest.staticAssets.length} static assets observed.`)
  parts.push('')

  // Pages
  parts.push('## Pages visited (URL paths)')
  parts.push('')
  const routesSample = digest.routes.slice(0, 40)
  for (const r of routesSample) {
    parts.push(`- ${r.url} (${r.visitCount} visit${r.visitCount === 1 ? '' : 's'})`)
  }
  if (digest.routes.length > 40) parts.push(`...and ${digest.routes.length - 40} more pages.`)
  parts.push('')

  // REST endpoints with inferred response shapes
  parts.push('## REST API surface')
  parts.push('')
  const restEndpoints = digest.endpoints.filter((e) => !e.graphql).slice(0, 30)
  for (const e of restEndpoints) {
    parts.push(`### ${e.method} ${e.normalizedPath} (${e.callCount} calls, statuses: ${Object.keys(e.statuses).join(',')})`)
    const responseShape = inferShape(e)
    if (responseShape) {
      parts.push('```ts')
      parts.push(responseShape)
      parts.push('```')
    }
    parts.push('')
  }
  if (digest.endpoints.filter((e) => !e.graphql).length > 30) {
    parts.push(`...and ${digest.endpoints.filter((e) => !e.graphql).length - 30} more endpoints.`)
    parts.push('')
  }

  // GraphQL ops
  if (digest.graphqlOps.length > 0) {
    parts.push('## GraphQL operations')
    parts.push('')
    for (const op of digest.graphqlOps.slice(0, 20)) {
      parts.push(`- **${op.operationType} ${op.name}** (${op.callCount} call${op.callCount === 1 ? '' : 's'}) — vars: ${JSON.stringify(op.variableTypes)} — returns types: ${op.typenames.join(', ') || '(no __typename)'}`)
    }
    if (digest.graphqlOps.length > 20) parts.push(`...and ${digest.graphqlOps.length - 20} more GraphQL ops.`)
    parts.push('')
  }

  // Static asset hints (script URLs reveal framework)
  const scriptAssets = digest.staticAssets.filter((a) => a.mimeType.includes('javascript')).slice(0, 20)
  if (scriptAssets.length > 0) {
    parts.push('## Frontend script URLs (framework / bundler hints)')
    parts.push('')
    for (const a of scriptAssets) parts.push(`- ${a.url}`)
    parts.push('')
  }

  // Actions from latest session (concrete user intent)
  const actions = latestSession.summary.actions ?? []
  if (actions.length > 0) {
    parts.push(`## User actions in the most recent session (${actions.length} total, latest 20 shown)`)
    parts.push('')
    for (const a of actions.slice(-20)) {
      parts.push(`- ${a.type} on ${a.selector.primary || '?'} (at ${a.url})`)
    }
    parts.push('')
  }

  // Console errors (architecture / quality signal)
  const errors = latestSession.summary.consoleErrors ?? []
  if (errors.length > 0) {
    parts.push(`## Console errors in latest session (${errors.length})`)
    parts.push('')
    for (const e of errors.slice(0, 10)) parts.push(`- ${e.message.slice(0, 200)}`)
    parts.push('')
  }

  parts.push('## Screenshots')
  parts.push('')
  parts.push('Representative screenshots from the latest session follow this prompt. These are the primary evidence for what the UI looks like and what the user is doing on each page.')

  return parts.join('\n')
}

function inferShape(e: EndpointEntry): string | null {
  const samples: unknown[] = []
  for (const raw of e.responseSamples.slice(0, 10)) {
    try {
      samples.push(JSON.parse(raw))
    } catch {
      // skip
    }
  }
  if (samples.length === 0) return null
  return inferType(samples, 'Response')
}

function pickRepresentativeScreenshots(session: StoredSession, max: number): ScreenshotInline[] {
  const all = session.screenshots ?? []
  if (all.length <= max) return all
  // Pick first, last, and evenly-spaced middle ones.
  const picked: ScreenshotInline[] = []
  const indices = new Set<number>()
  indices.add(0)
  indices.add(all.length - 1)
  const step = Math.max(1, Math.floor(all.length / (max - 1)))
  for (let i = step; i < all.length - 1 && indices.size < max; i += step) {
    indices.add(i)
  }
  for (const i of [...indices].sort((a, b) => a - b)) picked.push(all[i]!)
  return picked.slice(0, max)
}

function renderNarrativeMarkdown(digest: ProjectDigest, parsed: NarrativeJson): string {
  const lines: string[] = []
  lines.push(`# ${digest.host}`)
  if (parsed.service_type) lines.push(`**${parsed.service_type}**`)
  if (parsed.one_liner) {
    lines.push('')
    lines.push(parsed.one_liner)
  }
  if (parsed.target_audience) {
    lines.push('')
    lines.push(`*Target audience:* ${parsed.target_audience}`)
  }
  lines.push('')
  lines.push(`_Inferred from ${digest.sessionCount} captured session${digest.sessionCount === 1 ? '' : 's'} · ${digest.routes.length} pages · ${digest.endpoints.filter((e) => !e.graphql).length} REST endpoints · ${digest.graphqlOps.length} GraphQL ops._`)
  lines.push('')

  if (parsed.user_journeys && parsed.user_journeys.length > 0) {
    lines.push('## Observed user journeys')
    lines.push('')
    for (const j of parsed.user_journeys) {
      lines.push(`### ${j.name}`)
      lines.push('')
      lines.push(j.description)
      lines.push('')
    }
  }

  if (parsed.tech_stack_hints && parsed.tech_stack_hints.length > 0) {
    lines.push('## Tech stack hints')
    lines.push('')
    for (const h of parsed.tech_stack_hints) {
      lines.push(`- **${h.hint}** — ${h.evidence}`)
    }
    lines.push('')
  }

  if (parsed.architecture_observations) {
    lines.push('## Architecture observations')
    lines.push('')
    lines.push(parsed.architecture_observations)
    lines.push('')
  }

  if (parsed.reverse_engineering_checklist && parsed.reverse_engineering_checklist.length > 0) {
    lines.push('## Reverse-engineering checklist')
    lines.push('')
    for (const item of parsed.reverse_engineering_checklist) {
      lines.push(`- [ ] ${item}`)
    }
    lines.push('')
  }

  if (parsed.uncertainty) {
    lines.push('## What I could not determine')
    lines.push('')
    lines.push(parsed.uncertainty)
    lines.push('')
  }

  return lines.join('\n')
}
