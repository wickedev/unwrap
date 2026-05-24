import puppeteer, { type Browser } from '@cloudflare/puppeteer'
import type { Env } from './env'
import type { StoredSession } from '@unwrap/protocol'
import {
  appendMonitorRun,
  getMonitorConfig,
  intervalToMinutes,
  listEnrolledMonitors,
  newMonitorRunId,
  touchMonitorCheckedAt,
  type MonitorConfig,
  type MonitorRunSummary,
} from './storage/monitor'
import { getSession as getStoredSession, listSessions } from './storage/sessions'
import { getSlackConfig } from './storage/slack-config'
import { postSlackMessage } from './slack'

const PAGE_TIMEOUT_MS = 15_000
const NETWORK_IDLE_MS = 800
const MAX_CALLS_TRACKED = 500

interface LiveCapture {
  entryUrl: string
  finalUrl: string
  finalStatus?: number
  apiCalls: { method: string; normalizedPath: string; host: string; status: number }[]
  consoleErrorCount: number
  errorMessage?: string
}

// Decide if this monitor is due. The cron fires hourly — short-interval
// monitors will fire most ticks; daily monitors fire when 24h has elapsed
// since the last successful check.
export function isMonitorDue(cfg: MonitorConfig, now: number): boolean {
  if (!cfg.enabled) return false
  if (!cfg.lastCheckAt) return true
  const minutesSince = (now - cfg.lastCheckAt) / 60_000
  // 90% threshold gives a small grace so we don't slip an interval when
  // cron fires a few seconds late.
  return minutesSince >= intervalToMinutes(cfg.interval) * 0.9
}

export async function runDueMonitors(env: Env, origin: string): Promise<{ checked: number; alerted: number }> {
  const enrolment = await listEnrolledMonitors(env)
  const now = Date.now()
  let checked = 0
  let alerted = 0
  for (const e of enrolment) {
    const cfg = await getMonitorConfig(env, e.email, e.host)
    if (!cfg || !isMonitorDue(cfg, now)) continue
    try {
      const result = await runSingleMonitor(env, e.email, e.host, cfg, origin)
      checked++
      if (result.status === 'regression') alerted++
    } catch (err) {
      console.warn('[unwrap-monitor] check failed', e.email, e.host, asMessage(err))
    }
  }
  return { checked, alerted }
}

export async function runSingleMonitor(
  env: Env,
  email: string,
  host: string,
  cfg: MonitorConfig,
  origin: string,
): Promise<MonitorRunSummary> {
  const startedAt = Date.now()
  const baseline = await pickBaseline(env, email, host)
  const entryUrl = cfg.entryUrl || baseline?.summary.meta.url || `https://${host}/`

  let live: LiveCapture | null = null
  let errorMessage: string | undefined
  try {
    live = await captureLive(env, entryUrl)
  } catch (e) {
    errorMessage = asMessage(e)
  }

  const summary = buildSummary({
    runId: newMonitorRunId(),
    startedAt,
    entryUrl,
    baseline,
    live,
    errorMessage,
  })

  await appendMonitorRun(env, email, host, summary)
  await touchMonitorCheckedAt(env, email, host, startedAt)

  if (summary.status === 'regression' && cfg.alertSlack) {
    const slack = await getSlackConfig(env, email, host)
    if (slack) {
      const projectUrl = `${origin}/projects/${encodeURIComponent(host)}/monitor`
      await postSlackMessage(slack, {
        title: `🔭 Synthetic drift on ${host}`,
        text: summary.headline,
        fields: [
          ...(summary.newEndpointCount > 0 ? [{ name: 'New endpoints', value: String(summary.newEndpointCount) }] : []),
          ...(summary.missingEndpointCount > 0 ? [{ name: 'Missing endpoints', value: String(summary.missingEndpointCount) }] : []),
          ...(summary.statusChangeCount > 0 ? [{ name: 'Status changes', value: String(summary.statusChangeCount) }] : []),
          ...(summary.consoleErrorDelta !== 0 ? [{ name: 'Console error delta', value: (summary.consoleErrorDelta > 0 ? '+' : '') + String(summary.consoleErrorDelta) }] : []),
        ],
        link: { text: 'View monitor history', url: projectUrl },
      }).catch((e) => console.warn('[unwrap-monitor] slack alert failed', asMessage(e)))
    }
  }

  return summary
}

async function pickBaseline(env: Env, email: string, host: string): Promise<StoredSession | null> {
  const items = await listSessions(env, email)
  const candidate = items.find((s) => s.host === host)
  if (!candidate) return null
  return getStoredSession(env, email, candidate.id)
}

async function captureLive(env: Env, entryUrl: string): Promise<LiveCapture> {
  if (!env.BROWSER) throw new Error('Browser Rendering binding not available')
  let browser: Browser | null = null
  const apiCalls: LiveCapture['apiCalls'] = []
  let consoleErrors = 0
  let finalStatus: number | undefined
  try {
    browser = await puppeteer.launch(env.BROWSER)
    const page = await browser.newPage()
    page.on('response', (res) => {
      try {
        if (apiCalls.length >= MAX_CALLS_TRACKED) return
        const url = res.url()
        const req = res.request()
        const method = req.method()
        const status = res.status()
        const resourceType = req.resourceType()
        if (!isApiResource(resourceType, url, res.headers()['content-type'])) return
        const u = new URL(url)
        apiCalls.push({ method: method.toUpperCase(), normalizedPath: normalizePath(u.pathname), host: u.host, status })
      } catch {}
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors++
    })
    const navResp = await page.goto(entryUrl, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS })
    if (navResp) finalStatus = navResp.status()
    try { await page.waitForNetworkIdle({ idleTime: NETWORK_IDLE_MS, timeout: PAGE_TIMEOUT_MS }) } catch {}
    const finalUrl = page.url()
    await browser.close()
    browser = null
    return { entryUrl, finalUrl, ...(finalStatus !== undefined ? { finalStatus } : {}), apiCalls, consoleErrorCount: consoleErrors }
  } finally {
    if (browser) { try { await browser.close() } catch {} }
  }
}

interface BuildArgs {
  runId: string
  startedAt: number
  entryUrl: string
  baseline: StoredSession | null
  live: LiveCapture | null
  errorMessage?: string
}

function buildSummary(a: BuildArgs): MonitorRunSummary {
  const base: MonitorRunSummary = {
    id: a.runId,
    startedAt: a.startedAt,
    durationMs: Date.now() - a.startedAt,
    status: 'ok',
    newEndpointCount: 0,
    missingEndpointCount: 0,
    statusChangeCount: 0,
    consoleErrorCount: a.live?.consoleErrorCount ?? 0,
    consoleErrorDelta: 0,
    headline: 'OK — no drift detected vs baseline.',
    entryUrl: a.entryUrl,
    ...(a.baseline ? { baselineSessionId: a.baseline.id } : {}),
    ...(a.live?.finalUrl ? { finalUrl: a.live.finalUrl } : {}),
    ...(a.live?.finalStatus !== undefined ? { finalStatus: a.live.finalStatus } : {}),
  }

  if (!a.live) {
    return { ...base, status: 'error', headline: a.errorMessage ?? 'Live capture failed.', ...(a.errorMessage ? { errorMessage: a.errorMessage } : {}) }
  }

  if (a.live.finalStatus && a.live.finalStatus >= 400) {
    return { ...base, status: 'regression', headline: `Entry URL returned HTTP ${a.live.finalStatus}.` }
  }

  if (!a.baseline) {
    // No baseline yet — first run becomes the baseline reference; never alert.
    return base
  }

  const baselineCalls = (a.baseline.summary.apiCalls ?? []).slice(0, MAX_CALLS_TRACKED)
  const baselineSet = endpointSet(baselineCalls.map((c) => ({ method: c.method.toUpperCase(), normalizedPath: extractPath(c.url), host: hostOf(c.url), status: c.status })))
  const liveSet = endpointSet(a.live.apiCalls)

  const newEndpoints: string[] = []
  const missing: string[] = []
  let statusChanges = 0
  for (const k of liveSet.keys()) if (!baselineSet.has(k)) newEndpoints.push(k)
  for (const k of baselineSet.keys()) if (!liveSet.has(k)) missing.push(k)
  for (const [k, status] of liveSet) {
    const baseStatus = baselineSet.get(k)
    if (baseStatus !== undefined && baseStatus !== status) statusChanges++
  }
  const baselineConsoleErrors = a.baseline.summary.consoleErrors?.length ?? 0
  const consoleErrorDelta = a.live.consoleErrorCount - baselineConsoleErrors

  const isRegression = newEndpoints.length > 0 || missing.length > 0 || statusChanges > 0 || consoleErrorDelta > 0

  const headlineBits: string[] = []
  if (newEndpoints.length) headlineBits.push(`+${newEndpoints.length} new endpoint${newEndpoints.length === 1 ? '' : 's'}`)
  if (missing.length) headlineBits.push(`-${missing.length} missing`)
  if (statusChanges) headlineBits.push(`${statusChanges} status change${statusChanges === 1 ? '' : 's'}`)
  if (consoleErrorDelta > 0) headlineBits.push(`+${consoleErrorDelta} console error${consoleErrorDelta === 1 ? '' : 's'}`)

  return {
    ...base,
    status: isRegression ? 'regression' : 'ok',
    newEndpointCount: newEndpoints.length,
    missingEndpointCount: missing.length,
    statusChangeCount: statusChanges,
    consoleErrorDelta,
    headline: isRegression ? `Drift: ${headlineBits.join(' · ')}` : 'OK — no drift detected vs baseline.',
  }
}

function endpointSet(calls: { method: string; normalizedPath: string; host: string; status: number }[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of calls) {
    const key = `${c.method} ${c.host}${c.normalizedPath}`
    if (!m.has(key)) m.set(key, c.status)
  }
  return m
}

function extractPath(url: string): string {
  try { return normalizePath(new URL(url).pathname) } catch { return url }
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

function normalizePath(p: string): string {
  return '/' + p.split('/').filter(Boolean).map((seg) => {
    if (/^\d+$/.test(seg)) return '{id}'
    if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}'
    if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}'
    return seg
  }).join('/')
}

function isApiResource(resourceType: string, url: string, contentType?: string): boolean {
  if (resourceType === 'xhr' || resourceType === 'fetch') return true
  if (contentType && /json|graphql/i.test(contentType)) return true
  if (/\/(api|graphql|rpc|v\d+)\b/i.test(url)) return true
  return false
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
