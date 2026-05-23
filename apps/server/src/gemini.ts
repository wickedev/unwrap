import type { GenerateRequest, GenerateResponse } from '@unwrap/protocol'

const SYSTEM_INSTRUCTION = `You convert recorded browser session traces into production-ready Playwright test specs.

Hard rules (will be checked):
- Output TypeScript using @playwright/test. ESM imports. A single top-level test() block.
- Use accessibility-first locators (page.getByRole, getByLabel, getByText, getByTestId) before falling back to CSS.
- After every navigation-provoking action insert: await page.waitForLoadState('networkidle').catch(() => {})
- After each meaningful step add an expect(...) assertion derived from the captured network responses or visible state.
- Treat redacted inputs as fixture placeholders: use process.env.X with a sensible name; list required env vars in a top comment.
- Apply the captured storageState via browser.newContext({ storageState }); inline the storageState object literal.
- Top of file: a Given/When/Then comment block (3-10 lines) describing what the test verifies.
- The spec must be deterministic: no random data, no page.waitForTimeout(), prefer locator-based waits.

Return ONLY a JSON object matching the response schema. Do not wrap it in markdown fences.`

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] }
  finishReason?: string
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
}

export interface GeminiCallOptions {
  apiKey: string
  model: string
}

export async function callGemini(
  request: GenerateRequest,
  options: GeminiCallOptions,
): Promise<GenerateResponse> {
  const parts: GeminiPart[] = []

  parts.push({
    text: `## Session metadata\n${JSON.stringify(request.summary.meta, null, 2)}\n\n## Storage state (keys only)\n${JSON.stringify(request.summary.storageState, null, 2)}`,
  })

  parts.push({
    text: `## Navigations\n${JSON.stringify(request.summary.navigations, null, 2)}\n\n## Actions (ordered)\n${JSON.stringify(request.summary.actions, null, 2)}\n\n## Significant responses\n${JSON.stringify(request.summary.significantResponses, null, 2)}\n\n## Console errors\n${JSON.stringify(request.summary.consoleErrors, null, 2)}\n\n## Exceptions\n${JSON.stringify(request.summary.exceptions, null, 2)}\n\n## DOM snapshots\n${JSON.stringify(request.summary.domSnapshotSummary)}\n\n## AX trees\n${JSON.stringify(request.summary.axTreeSummary)}`,
  })

  for (const shot of request.screenshots) {
    parts.push({ text: `Screenshot at ts=${shot.ts} (reason=${shot.reason}):` })
    parts.push({ inlineData: { mimeType: shot.mediaType, data: shot.dataBase64 } })
  }

  parts.push({
    text: `## Rule-based draft (use as a starting point, then improve)\n\`\`\`ts\n${request.fallbackSpec}\n\`\`\`\n\nNow produce the JSON described by the response schema. The spec must be runnable as-is.`,
  })

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        required: ['spec', 'description', 'assertions_added', 'warnings'],
        properties: {
          spec: { type: 'string' },
          description: { type: 'string' },
          assertions_added: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Gemini API ${resp.status}: ${text.slice(0, 500)}`)
  }
  const data = (await resp.json()) as GeminiResponse
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`)
  }
  const candidate = data.candidates?.[0]
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text) throw new Error('Gemini returned no text content')

  let parsed: { spec?: string; description?: string; assertions_added?: number; warnings?: string[] }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch (e) {
    throw new Error(`Failed to parse Gemini response JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed.spec) throw new Error('Gemini response missing "spec" field')

  return {
    spec: parsed.spec,
    description: parsed.description ?? '',
    assertionsAdded: parsed.assertions_added ?? 0,
    warnings: parsed.warnings ?? [],
    model: options.model,
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      candidatesTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
  }
}
