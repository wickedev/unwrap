import type { ApiCall, StoredSession } from '@unwrap/protocol'

export interface PerformanceReport {
  host: string
  // Per-endpoint stats sorted by p95 desc — worst tail-latency first.
  endpoints: EndpointPerf[]
  // The absolute slowest 20 individual calls across all sessions, useful
  // for outlier hunting (the one 8-second call hiding behind a 60ms p50).
  slowestCalls: SlowCall[]
  // Endpoints that show N+1 patterns — same endpoint called many times
  // in quick succession on the same page. Heuristic, not authoritative.
  n1Suspects: N1Pattern[]
  // Coverage info so the UI can be honest about partial data.
  callsTotal: number
  callsWithLatency: number
  sessionCountTotal: number
  sessionsWithLatency: number
}

export interface EndpointPerf {
  key: string // method + normalizedPath
  method: string
  normalizedPath: string
  callCount: number
  // Status histogram so the UI can colour-code error rates.
  statuses: Record<number, number>
  p50: number
  p90: number
  p95: number
  max: number
  // Worst-case error count (4xx + 5xx).
  errorCount: number
}

export interface SlowCall {
  method: string
  url: string
  status: number
  latencyMs: number
  sessionId: string
}

export interface N1Pattern {
  endpoint: string
  // Number of distinct N+1 burst occurrences across sessions.
  occurrences: number
  // Highest burst size seen (e.g., "10 hits to /api/users/{id} in 300ms").
  maxBurstSize: number
  maxBurstSpanMs: number
  exampleSessionId: string
}

// Heuristic — same endpoint hit at least N times within W ms qualifies
// as a burst suggestive of an N+1 pattern. These thresholds bias toward
// false-negatives so the UI doesn't cry wolf on legit polling.
const N1_MIN_BURST = 4
const N1_BURST_WINDOW_MS = 1000

// Walks every captured call across all sessions. Computes per-endpoint
// percentiles for latency, picks the absolute slowest calls, and runs a
// simple N+1 detector over each session's chronological call stream.
export function analyzeProjectPerformance(host: string, sessions: StoredSession[]): PerformanceReport {
  const allCalls: { c: ApiCall; sessionId: string }[] = []
  let callsTotal = 0
  let callsWithLatency = 0
  const sessionsWithLatency = new Set<string>()

  for (const s of sessions) {
    for (const c of s.summary.apiCalls ?? []) {
      callsTotal++
      if (typeof c.latencyMs === 'number') {
        callsWithLatency++
        sessionsWithLatency.add(s.id)
        allCalls.push({ c, sessionId: s.id })
      }
    }
  }

  // Per-endpoint aggregation
  const byKey = new Map<string, EndpointPerf & { latencies: number[] }>()
  for (const { c } of allCalls) {
    let hostname = ''
    let path = c.url
    try {
      const u = new URL(c.url)
      hostname = u.host
      path = normalizePath(u.pathname)
    } catch {
      // ignore
    }
    void hostname // unused for now; key is method+path
    const key = `${c.method.toUpperCase()} ${path}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        key,
        method: c.method.toUpperCase(),
        normalizedPath: path,
        callCount: 0,
        statuses: {},
        p50: 0, p90: 0, p95: 0, max: 0,
        errorCount: 0,
        latencies: [],
      }
      byKey.set(key, entry)
    }
    entry.callCount++
    entry.statuses[c.status] = (entry.statuses[c.status] ?? 0) + 1
    if (c.status >= 400) entry.errorCount++
    entry.latencies.push(c.latencyMs!)
  }

  const endpoints: EndpointPerf[] = []
  for (const e of byKey.values()) {
    e.latencies.sort((a, b) => a - b)
    e.p50 = percentile(e.latencies, 0.5)
    e.p90 = percentile(e.latencies, 0.9)
    e.p95 = percentile(e.latencies, 0.95)
    e.max = e.latencies[e.latencies.length - 1] ?? 0
    const { latencies: _, ...rest } = e
    endpoints.push(rest)
  }
  endpoints.sort((a, b) => b.p95 - a.p95)

  // Slowest individual calls
  const slowestCalls = [...allCalls]
    .sort((a, b) => (b.c.latencyMs! - a.c.latencyMs!))
    .slice(0, 20)
    .map(({ c, sessionId }): SlowCall => ({
      method: c.method.toUpperCase(),
      url: c.url,
      status: c.status,
      latencyMs: c.latencyMs!,
      sessionId,
    }))

  // N+1 detection — for each session, sort by ts and scan for bursts of
  // the same endpoint within a tight window.
  const n1Map = new Map<string, N1Pattern>()
  for (const s of sessions) {
    const sessionCalls = (s.summary.apiCalls ?? []).slice().sort((a, b) => a.ts - b.ts)
    for (let i = 0; i < sessionCalls.length; i++) {
      const head = sessionCalls[i]!
      let endpoint = ''
      try { endpoint = `${head.method.toUpperCase()} ${normalizePath(new URL(head.url).pathname)}` } catch { continue }
      let j = i
      while (j < sessionCalls.length) {
        const cur = sessionCalls[j]!
        let curEp = ''
        try { curEp = `${cur.method.toUpperCase()} ${normalizePath(new URL(cur.url).pathname)}` } catch { break }
        if (curEp !== endpoint) break
        if (cur.ts - head.ts > N1_BURST_WINDOW_MS) break
        j++
      }
      const burstSize = j - i
      if (burstSize >= N1_MIN_BURST) {
        const spanMs = sessionCalls[j - 1]!.ts - head.ts
        const existing = n1Map.get(endpoint)
        if (!existing) {
          n1Map.set(endpoint, {
            endpoint,
            occurrences: 1,
            maxBurstSize: burstSize,
            maxBurstSpanMs: spanMs,
            exampleSessionId: s.id,
          })
        } else {
          existing.occurrences++
          if (burstSize > existing.maxBurstSize) {
            existing.maxBurstSize = burstSize
            existing.maxBurstSpanMs = spanMs
            existing.exampleSessionId = s.id
          }
        }
        i = j - 1 // skip past this burst so the next iteration starts fresh
      }
    }
  }

  const n1Suspects = [...n1Map.values()].sort((a, b) => b.maxBurstSize - a.maxBurstSize)

  return {
    host,
    endpoints,
    slowestCalls,
    n1Suspects,
    callsTotal,
    callsWithLatency,
    sessionCountTotal: sessions.length,
    sessionsWithLatency: sessionsWithLatency.size,
  }
}

function percentile(sortedLatencies: number[], p: number): number {
  if (sortedLatencies.length === 0) return 0
  const idx = Math.max(0, Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * p)))
  return sortedLatencies[idx]!
}

function normalizePath(p: string): string {
  return (
    '/' +
    p.split('/').filter(Boolean).map((seg) => {
      if (/^\d+$/.test(seg)) return '{id}'
      if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}'
      if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}'
      return seg
    }).join('/')
  )
}
