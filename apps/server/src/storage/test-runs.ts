import type { Env } from '../env'

export interface TestRun {
  id: string
  host: string
  uploadedAt: number
  // Optional CI metadata — gitSha, branch, prNumber, runUrl. All free
  // text supplied by the caller.
  ci?: {
    gitSha?: string
    branch?: string
    prNumber?: number
    runUrl?: string
  }
  // Per-spec results.
  specs: TestSpecResult[]
  // Aggregate counters so the list view doesn't have to walk specs.
  totals: {
    passed: number
    failed: number
    skipped: number
    flaky: number
    durationMs: number
  }
}

export interface TestSpecResult {
  // Spec file name (matches what the canonical bundle emits, e.g.
  // "tests/login-and-dashboard.spec.ts").
  file: string
  // Test title (the string passed to test()).
  title: string
  status: 'passed' | 'failed' | 'skipped' | 'flaky'
  durationMs: number
  // Optional error excerpt — first line of the failure message.
  errorMessage?: string
  errorStack?: string
}

const RUNS_TTL = 90 * 24 * 60 * 60

function runKey(email: string, host: string, runId: string): string {
  return `test-run:${email}:${host}:${runId}`
}
function indexKey(email: string, host: string): string {
  return `test-runs-index:${email}:${host}`
}

export async function appendTestRun(env: Env, email: string, host: string, run: TestRun): Promise<void> {
  if (!env.SESSIONS) throw new Error('SESSIONS KV not configured')
  await env.SESSIONS.put(runKey(email, host, run.id), JSON.stringify(run), { expirationTtl: RUNS_TTL })
  const list = await listTestRunIds(env, email, host)
  list.unshift(run.id)
  // Keep the index bounded — older runs are still reachable by id, but
  // the list view shows the most recent 200.
  const trimmed = list.slice(0, 200)
  await env.SESSIONS.put(indexKey(email, host), JSON.stringify(trimmed), { expirationTtl: RUNS_TTL })
}

export async function listTestRunIds(env: Env, email: string, host: string): Promise<string[]> {
  if (!env.SESSIONS) return []
  const raw = await env.SESSIONS.get(indexKey(email, host))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as string[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export async function getTestRun(env: Env, email: string, host: string, runId: string): Promise<TestRun | null> {
  if (!env.SESSIONS) return null
  return (await env.SESSIONS.get(runKey(email, host, runId), 'json')) as TestRun | null
}

export async function listRecentTestRuns(env: Env, email: string, host: string, limit = 30): Promise<TestRun[]> {
  const ids = (await listTestRunIds(env, email, host)).slice(0, limit)
  const runs = (await Promise.all(ids.map((id) => getTestRun(env, email, host, id))))
    .filter((r): r is TestRun => r !== null)
  return runs
}

export function newTestRunId(): string {
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')
  const rand = crypto.getRandomValues(new Uint8Array(6))
  return seconds + Array.from(rand).map((b) => b.toString(16).padStart(2, '0')).join('')
}
