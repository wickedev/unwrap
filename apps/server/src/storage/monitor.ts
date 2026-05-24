import type { Env } from '../env'

export type MonitorInterval = '15m' | '1h' | '6h' | '24h'

export interface MonitorConfig {
  // Per-project synthetic monitoring settings. When enabled, the cron
  // worker walks every project owned by this email at the configured
  // cadence and runs a lightweight live check (navigate baseline URL,
  // collect status / API surface / console errors) so drift surfaces
  // automatically without a fresh extension capture.
  enabled: boolean
  interval: MonitorInterval
  // Custom entry URL — defaults to the most recent session's start URL.
  // Useful when the project's "canary" page lives at a known path.
  entryUrl?: string
  // Push regression alerts via the project's Slack webhook if set.
  alertSlack: boolean
  lastCheckAt?: number
  updatedAt: number
}

export interface MonitorRunSummary {
  id: string
  startedAt: number
  durationMs: number
  status: 'ok' | 'regression' | 'error'
  // Numeric drift counters vs baseline. Zero on "ok"; populated on
  // "regression". On "error" the runner couldn't reach the URL.
  newEndpointCount: number
  missingEndpointCount: number
  statusChangeCount: number
  consoleErrorCount: number
  consoleErrorDelta: number
  headline: string
  baselineSessionId?: string
  // Snapshot fields for the run-detail page.
  entryUrl: string
  finalUrl?: string
  finalStatus?: number
  errorMessage?: string
}

const TTL_SECONDS = 365 * 24 * 60 * 60
const RUN_TTL_SECONDS = 90 * 24 * 60 * 60
const MAX_RUNS_KEPT = 50

const configKey = (email: string, host: string) => `monitor-config:${email}:${host}`
const configIndexKey = (email: string) => `monitor-configs-by-email:${email}`
// Cross-tenant enrolment index — lets the cron loop iterate every
// (email, host) pair that has monitoring enabled without walking every
// user. Maintained by setMonitorConfig / deleteMonitorConfig.
const globalEnrolmentKey = () => `monitor-enrolment`
const runsKey = (email: string, host: string) => `monitor-runs:${email}:${host}`

export async function setMonitorConfig(
  env: Env,
  email: string,
  host: string,
  cfg: Omit<MonitorConfig, 'updatedAt' | 'lastCheckAt'>,
): Promise<MonitorConfig> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV not configured')
  const prior = await getMonitorConfig(env, email, host)
  const rec: MonitorConfig = {
    ...cfg,
    ...(prior?.lastCheckAt ? { lastCheckAt: prior.lastCheckAt } : {}),
    updatedAt: Date.now(),
  }
  await env.SESSIONS.put(configKey(email, host), JSON.stringify(rec), { expirationTtl: TTL_SECONDS })
  const list = await listMonitorHosts(env, email)
  if (!list.includes(host)) {
    list.unshift(host)
    await env.SESSIONS.put(configIndexKey(email), JSON.stringify(list), { expirationTtl: TTL_SECONDS })
  }
  await updateEnrolment(env, email, host, cfg.enabled)
  return rec
}

export async function getMonitorConfig(env: Env, email: string, host: string): Promise<MonitorConfig | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(configKey(email, host), 'json')) as MonitorConfig | null
}

export async function touchMonitorCheckedAt(env: Env, email: string, host: string, ts: number): Promise<void> {
  const cfg = await getMonitorConfig(env, email, host)
  if (!cfg) return
  cfg.lastCheckAt = ts
  await env.SESSIONS!.put(configKey(email, host), JSON.stringify(cfg), { expirationTtl: TTL_SECONDS })
}

export async function deleteMonitorConfig(env: Env, email: string, host: string): Promise<boolean> {
  if (!env.SESSIONS) return false
  const had = (await env.SESSIONS.get(configKey(email, host))) !== null
  if (!had) return false
  await env.SESSIONS.delete(configKey(email, host))
  const list = await listMonitorHosts(env, email)
  await env.SESSIONS.put(configIndexKey(email), JSON.stringify(list.filter((h) => h !== host)), { expirationTtl: TTL_SECONDS })
  await updateEnrolment(env, email, host, false)
  return true
}

export async function listMonitorHosts(env: Env, email: string): Promise<string[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(configIndexKey(email))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as string[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export async function listEnrolledMonitors(env: Env): Promise<{ email: string; host: string }[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(globalEnrolmentKey())
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as { email: string; host: string }[]) : []
  } catch {
    return []
  }
}

async function updateEnrolment(env: Env, email: string, host: string, enabled: boolean): Promise<void> {
  if (!env.SESSIONS) return
  const list = await listEnrolledMonitors(env)
  const without = list.filter((e) => !(e.email === email && e.host === host))
  const next = enabled ? [{ email, host }, ...without] : without
  await env.SESSIONS.put(globalEnrolmentKey(), JSON.stringify(next))
}

export async function appendMonitorRun(env: Env, email: string, host: string, run: MonitorRunSummary): Promise<void> {
  if (!env.SESSIONS) return
  const runs = await listMonitorRuns(env, email, host)
  const next = [run, ...runs].slice(0, MAX_RUNS_KEPT)
  await env.SESSIONS.put(runsKey(email, host), JSON.stringify(next), { expirationTtl: RUN_TTL_SECONDS })
}

export async function listMonitorRuns(env: Env, email: string, host: string): Promise<MonitorRunSummary[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(runsKey(email, host))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as MonitorRunSummary[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function newMonitorRunId(): string {
  const sec = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')
  const rnd = crypto.getRandomValues(new Uint8Array(4))
  return sec + Array.from(rnd).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function intervalToMinutes(i: MonitorInterval): number {
  switch (i) {
    case '15m': return 15
    case '1h': return 60
    case '6h': return 360
    case '24h': return 1440
  }
}
