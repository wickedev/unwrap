import type { StaticAsset, StoredSession } from '@unwrap/protocol'
import type { Env } from './env'

export interface SpecRepairResult {
  // Verbatim copy of the spec we started from.
  originalSpec: string
  // The patched spec Gemini produced. May be empty if Gemini wouldn't
  // change anything; the page should fall back to a "no change suggested"
  // message in that case.
  repairedSpec: string
  // Plain-text rationale Gemini emitted alongside the patched spec.
  rationale: string
  // Which captured asset we used as ground-truth DOM. null when no
  // matching HTML asset was found — in that case we still ran the
  // repair, but Gemini only saw the error message.
  contextUsedUrl: string | null
  // Which sessions contributed assets to the search.
  contextScannedSessionCount: number
  // Gemini metadata.
  model: string
  usage: { promptTokens: number; candidatesTokens: number; totalTokens: number }
}

const SYSTEM_INSTRUCTION = `You repair Playwright test specs whose selectors no longer match the current DOM.

Inputs you get:
  - The current spec text (TypeScript using @playwright/test).
  - An optional error message describing why the spec failed at runtime.
  - The current HTML of the page the spec is most likely targeting,
    captured by an observability tool called Unwrap.

Your job: output a corrected spec that runs against the current DOM.

Hard rules:
  - Preserve the test name, structure, comments, and assertions where they make sense.
  - Only change selectors / locators / wait conditions. Don't rewrite the test's intent.
  - Prefer accessibility-first locators (page.getByRole, getByLabel, getByText, getByTestId)
    over CSS / XPath when the DOM supports them.
  - If no change is needed, return the original spec unchanged and explain why in rationale.
  - Output ONLY the JSON described by the response schema.`

// Picks the most recent same-host session's static assets and finds an
// HTML body that matches one of the URLs the spec navigates to. Returns
// the asset (with body) plus the URL match; null when no match.
function findRepairContext(
  spec: string,
  sessions: StoredSession[],
): { asset: StaticAsset; url: string } | null {
  const gotoUrls = extractGotoUrls(spec)
  if (gotoUrls.length === 0) return null
  const sorted = [...sessions].sort((a, b) => b.uploadedAt - a.uploadedAt)
  for (const s of sorted) {
    const assets = s.summary.staticAssets ?? []
    for (const url of gotoUrls) {
      const match = assets.find(
        (a) => a.url === url || sameUrlIgnoringSearch(a.url, url),
      )
      if (match?.body && match.mimeType.startsWith('text/html')) {
        return { asset: match, url }
      }
    }
  }
  return null
}

function extractGotoUrls(spec: string): string[] {
  const out = new Set<string>()
  const re = /page\.(?:goto|waitForURL)\s*\(\s*(['"`])([^'"`]+)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(spec)) !== null) out.add(m[2]!)
  return [...out]
}

function sameUrlIgnoringSearch(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.host === ub.host && ua.pathname === ub.pathname
  } catch {
    return false
  }
}

export async function repairSpec(opts: {
  env: Env
  originalSpec: string
  errorMessage: string
  sessions: StoredSession[]
}): Promise<SpecRepairResult> {
  if (!opts.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured')
  const model = opts.env.GEMINI_MODEL || 'gemini-2.5-flash'

  const ctx = findRepairContext(opts.originalSpec, opts.sessions)
  const promptParts: string[] = []
  promptParts.push('## Current spec')
  promptParts.push('```ts')
  promptParts.push(opts.originalSpec)
  promptParts.push('```')
  promptParts.push('')
  if (opts.errorMessage) {
    promptParts.push('## Failure error message')
    promptParts.push('```')
    promptParts.push(opts.errorMessage.slice(0, 2000))
    promptParts.push('```')
    promptParts.push('')
  }
  if (ctx) {
    // Cap the HTML body — typical pages are large. 80KB is enough for
    // Gemini to find the selectors but small enough to keep the round-trip
    // sane.
    const html = ctx.asset.body!.slice(0, 80_000)
    promptParts.push(`## Current HTML of the target page (\`${ctx.url}\`)`)
    promptParts.push('```html')
    promptParts.push(html)
    promptParts.push('```')
    promptParts.push('')
  } else {
    promptParts.push('## No current DOM available')
    promptParts.push('We couldn\'t find a captured HTML asset matching the spec\'s page.goto() URL.')
    promptParts.push('Make best-effort repair from the error message + spec alone, or acknowledge that you need a fresh capture.')
    promptParts.push('')
  }
  promptParts.push('Output the repaired spec now.')

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: promptParts.join('\n') }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 4096 },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        required: ['repaired_spec', 'rationale'],
        properties: {
          repaired_spec: { type: 'string', description: 'Full repaired TypeScript spec. If no change is needed, return the original unchanged.' },
          rationale: { type: 'string', description: 'What you changed and why (or why no change was needed). Cite specific selector swaps.' },
        },
      },
    },
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.env.GEMINI_API_KEY)}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    throw new Error(`Gemini API ${resp.status}: ${(await resp.text()).slice(0, 400)}`)
  }
  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    promptFeedback?: { blockReason?: string }
  }
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`)
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new Error('Gemini returned no text')

  let parsed: { repaired_spec?: string; rationale?: string }
  try {
    parsed = JSON.parse(text) as { repaired_spec?: string; rationale?: string }
  } catch {
    throw new Error(`Could not parse Gemini JSON: ${text.slice(0, 200)}`)
  }

  return {
    originalSpec: opts.originalSpec,
    repairedSpec: parsed.repaired_spec ?? '',
    rationale: parsed.rationale ?? '',
    contextUsedUrl: ctx?.url ?? null,
    contextScannedSessionCount: opts.sessions.length,
    model,
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      candidatesTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
  }
}
