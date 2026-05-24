#!/usr/bin/env node
import { chromium, type Page, type CDPSession } from 'playwright'
import type {
  ApiCall,
  SessionSummary,
  UploadSessionRequest,
  UploadSessionResponse,
  ErrorResponse,
} from '@unwrap/protocol'

interface CliArgs {
  server: string
  token: string
  host?: string
  urls: string[]
  // Optional pause per URL (ms) to let dynamic content / late XHRs settle.
  dwellMs: number
  viewportWidth: number
  viewportHeight: number
  // Page-load timeout per URL.
  timeoutMs: number
}

main().catch((err) => {
  console.error('unwrap-cli:', err.message ?? err)
  process.exit(1)
})

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.urls.length === 0) {
    printHelp()
    process.exit(2)
  }

  const startedAt = new Date()
  console.log(`unwrap-cli: capturing ${args.urls.length} URL${args.urls.length === 1 ? '' : 's'} → ${args.server}`)

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: args.viewportWidth, height: args.viewportHeight },
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')

  const requests = new Map<string, { ts: number; method: string; url: string; headers: Record<string, string>; postData?: string }>()
  const responses = new Map<string, { ts: number; status: number; url: string; headers: Record<string, string>; mimeType: string; bodyResolver?: () => Promise<string | undefined> }>()
  const navigations: SessionSummary['navigations'] = []
  const consoleErrors: SessionSummary['consoleErrors'] = []
  const exceptions: SessionSummary['exceptions'] = []

  cdp.on('Network.requestWillBeSent', (params) => {
    requests.set(params.requestId, {
      ts: Math.round(params.timestamp * 1000),
      method: params.request.method,
      url: params.request.url,
      headers: scrubHeaders(params.request.headers as Record<string, string>),
      ...(params.request.postData !== undefined ? { postData: String(params.request.postData).slice(0, 50_000) } : {}),
    })
  })
  cdp.on('Network.responseReceived', (params) => {
    const r = params.response
    responses.set(params.requestId, {
      ts: Math.round(params.timestamp * 1000),
      status: r.status,
      url: r.url,
      headers: scrubHeaders(r.headers as Record<string, string>),
      mimeType: r.mimeType,
      bodyResolver: async () => {
        try {
          const body = await cdp.send('Network.getResponseBody', { requestId: params.requestId })
          if (!body) return undefined
          if (body.base64Encoded) return undefined // skip binary
          return body.body.slice(0, 50_000)
        } catch {
          return undefined
        }
      },
    })
  })

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ ts: Date.now(), message: msg.text().slice(0, 4000) })
    }
  })
  page.on('pageerror', (err) => {
    exceptions.push({ ts: Date.now(), message: err.message.slice(0, 4000), ...(err.stack ? { stack: err.stack.slice(0, 8000) } : {}) })
  })

  for (const url of args.urls) {
    console.log(`  → ${url}`)
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: args.timeoutMs })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`    nav warning: ${msg.split('\n')[0]}`)
    }
    navigations.push({ ts: Date.now(), url: page.url(), source: 'committed' })
    if (args.dwellMs > 0) await page.waitForTimeout(args.dwellMs)
  }

  // Drain response bodies for anything that looks JSON-shaped (this is
  // the same filter the server-side API inventory uses).
  const apiCalls: ApiCall[] = []
  for (const [reqId, req] of requests) {
    const resp = responses.get(reqId)
    if (!resp) continue
    if (!isApiLike(req.method, resp.url, resp.mimeType)) continue
    const responseBody = resp.bodyResolver ? await resp.bodyResolver() : undefined
    const requestBody = req.postData
    const latencyMs = resp.ts >= req.ts ? resp.ts - req.ts : undefined
    const call: ApiCall = {
      ts: req.ts,
      method: req.method,
      url: req.url,
      requestHeaders: req.headers,
      ...(requestBody !== undefined ? { requestBody } : {}),
      status: resp.status,
      responseMimeType: resp.mimeType,
      ...(responseBody !== undefined ? { responseBody } : {}),
      responseHeaders: resp.headers,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    }
    const gql = detectGraphql(req.method, req.url, requestBody)
    if (gql) call.graphql = gql
    apiCalls.push(call)
  }

  // Screenshot of the last-visited URL (good representative of the run).
  const screenshotBuf = await page.screenshot({ type: 'png' })
  const screenshotBase64 = screenshotBuf.toString('base64')

  await browser.close()

  // Derive a host string for the upload — explicit --host wins; otherwise
  // use the host of the first URL.
  const inferredHost = args.host ?? (() => {
    try { return new URL(args.urls[0]!).host } catch { return 'unknown-host' }
  })()

  const summary: SessionSummary = {
    meta: {
      url: args.urls[0]!,
      host: inferredHost,
      viewport: { width: args.viewportWidth, height: args.viewportHeight },
      locale: 'en-US',
      timezone: 'UTC',
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      counts: { navigations: navigations.length, apiCalls: apiCalls.length },
    },
    navigations,
    actions: [],
    storageState: null,
    consoleErrors,
    exceptions,
    significantResponses: apiCalls.slice(0, 50).map((c) => ({
      url: c.url,
      status: c.status,
      mimeType: c.responseMimeType,
      method: c.method,
      ts: c.ts,
    })),
    axTreeSummary: [],
    domSnapshotSummary: [],
    apiCalls,
  }

  const upload: UploadSessionRequest = {
    clientSessionId: `cli-${startedAt.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`,
    summary,
    fallbackSpec: '// CLI capture — no Playwright spec generated. Use the web UI for that.',
    screenshots: [{
      ts: Date.now(),
      reason: 'cli-final',
      mediaType: 'image/png',
      dataBase64: screenshotBase64,
    }],
  }

  console.log(`unwrap-cli: uploading session (${apiCalls.length} api call${apiCalls.length === 1 ? '' : 's'}, ${navigations.length} nav${navigations.length === 1 ? '' : 's'}, ${consoleErrors.length} console error${consoleErrors.length === 1 ? '' : 's'})`)
  const resp = await fetch(`${stripTrailingSlash(args.server)}/api/sessions`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${args.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(upload),
  })
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`
    try {
      const j = (await resp.json()) as ErrorResponse
      if (j.error) detail = j.detail ? `${j.error}: ${j.detail}` : j.error
    } catch {
      // ignore
    }
    throw new Error(`upload failed: ${detail}`)
  }
  const result = (await resp.json()) as UploadSessionResponse
  console.log(`unwrap-cli: uploaded → ${result.url}`)
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    server: process.env['UNWRAP_SERVER'] ?? '',
    token: process.env['UNWRAP_TOKEN'] ?? '',
    urls: [],
    dwellMs: 1500,
    viewportWidth: 1280,
    viewportHeight: 800,
    timeoutMs: 30_000,
  }
  let i = 0
  // First positional is the subcommand; we only support `capture` for now,
  // but accept either `capture <urls>` or bare `<urls>` for ergonomics.
  if (argv[0] === 'capture') i = 1
  for (; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else if (a.startsWith('--server=')) out.server = a.slice('--server='.length)
    else if (a.startsWith('--token=')) out.token = a.slice('--token='.length)
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length)
    else if (a.startsWith('--dwell=')) out.dwellMs = Number(a.slice('--dwell='.length)) || out.dwellMs
    else if (a.startsWith('--viewport=')) {
      const [w, h] = a.slice('--viewport='.length).split('x').map(Number)
      if (w) out.viewportWidth = w
      if (h) out.viewportHeight = h
    }
    else if (a.startsWith('--timeout=')) out.timeoutMs = Number(a.slice('--timeout='.length)) || out.timeoutMs
    else if (a.startsWith('-')) {
      console.warn(`unwrap-cli: unknown flag ${a}`)
    }
    else out.urls.push(a)
  }
  if (!out.server) throw new Error('Missing --server (or UNWRAP_SERVER env)')
  if (!out.token) throw new Error('Missing --token (or UNWRAP_TOKEN env)')
  return out
}

function printHelp(): void {
  console.log(`unwrap-cli — capture URLs headlessly and upload to an Unwrap server.

Usage:
  npx @unwrap/cli capture --server=https://… --token=… [options] <urls...>

Options:
  --server=URL        Unwrap server origin (env: UNWRAP_SERVER)
  --token=TOKEN       API token from /settings/tokens (env: UNWRAP_TOKEN)
  --host=HOST         Override the host field on the upload (default: host of first URL)
  --dwell=MS          Pause after each navigation to let async XHRs settle (default 1500)
  --viewport=WxH      Browser viewport (default 1280x800)
  --timeout=MS        Per-URL page load timeout (default 30000)
  -h, --help          This help

Examples:
  npx @unwrap/cli capture \\
    --server=https://unwrap-server.example.dev \\
    --token=uw_ci_... \\
    https://staging.app/login \\
    https://staging.app/dashboard

Tip: in CI, pipe the URL list from your routes config; pair captures with
the project diff endpoint to comment on PRs when the API surface drifts.`)
}

// ---- inferred from the extension's existing logic --------------------------

function isApiLike(method: string, url: string, mimeType: string): boolean {
  const m = method.toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return true
  if (mimeType.includes('json') || mimeType.includes('graphql') || mimeType.includes('event-stream')) return true
  if (/\/api\/|\/graphql|\/rpc|\/rest\//i.test(url)) return true
  return false
}

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token',
])

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = `[REDACTED:${typeof v === 'string' ? v.length : 0}]`
    } else {
      out[k] = String(v)
    }
  }
  return out
}

function detectGraphql(method: string, url: string, body: string | undefined): ApiCall['graphql'] | null {
  if (!body) return null
  if (!/\/graphql(?:\?|$|\/)/i.test(url) && method.toUpperCase() !== 'POST') return null
  try {
    const parsed = JSON.parse(body)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    const query: string | undefined = typeof first?.query === 'string' ? first.query : undefined
    if (!query) return null
    const operationName: string | undefined = typeof first?.operationName === 'string' ? first.operationName : undefined
    const opMatch = query.match(/^\s*(query|mutation|subscription)\b/i)
    const operationType = (opMatch?.[1]?.toLowerCase() as 'query' | 'mutation' | 'subscription' | undefined) ?? 'query'
    return {
      operationType,
      ...(operationName ? { operationName } : {}),
      queryHash: fnv1a(query),
    }
  } catch {
    return null
  }
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}
