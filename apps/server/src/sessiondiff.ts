import type { SerializedAction, SessionSummary, StoredSession } from '@unwrap/protocol'

export interface SessionDiff {
  baseline: { id: string; startedAt: string; uploadedAt: number; host: string; durationMs: number }
  current: { id: string; startedAt: string; uploadedAt: number; host: string; durationMs: number }
  actions: ActionDiff
  network: NetworkDiff
  console: { baselineCount: number; currentCount: number; sampleNew: string[] }
  exceptions: { baselineCount: number; currentCount: number; sampleNew: string[] }
  finalUrl: { baseline: string; current: string; match: boolean }
  navigations: { baselineCount: number; currentCount: number }
}

export interface ActionDiff {
  total: { baseline: number; current: number }
  ops: ActionOp[]
}

// Longest-common-subsequence alignment of the two action streams.
// Each op represents one row in the merged diff view.
export type ActionOp =
  | { kind: 'keep'; baseline: SerializedAction; current: SerializedAction }
  | { kind: 'add'; current: SerializedAction }
  | { kind: 'remove'; baseline: SerializedAction }

export interface NetworkDiff {
  common: NetworkEntry[]
  onlyInBaseline: NetworkEntry[]
  onlyInCurrent: NetworkEntry[]
  statusChanged: { url: string; method?: string; baselineStatus: number; currentStatus: number }[]
}

interface NetworkEntry {
  url: string
  method?: string
  status: number
  mimeType: string
}

export function diffSessions(baseline: StoredSession, current: StoredSession): SessionDiff {
  const actions = diffActions(baseline.summary.actions, current.summary.actions)
  const network = diffNetwork(baseline.summary.significantResponses, current.summary.significantResponses)

  const baselineFinalUrl =
    baseline.verification?.finalUrl ?? lastNavigationUrl(baseline.summary) ?? baseline.summary.meta.url
  const currentFinalUrl =
    current.verification?.finalUrl ?? lastNavigationUrl(current.summary) ?? current.summary.meta.url

  const baselineConsole = baseline.summary.consoleErrors ?? []
  const currentConsole = current.summary.consoleErrors ?? []
  const baselineExc = baseline.summary.exceptions ?? []
  const currentExc = current.summary.exceptions ?? []

  const consoleNew = currentConsole
    .filter((c) => !baselineConsole.some((b) => b.message === c.message))
    .map((c) => c.message)
    .slice(0, 5)
  const exceptionsNew = currentExc
    .filter((c) => !baselineExc.some((b) => b.message === c.message))
    .map((c) => c.message)
    .slice(0, 5)

  return {
    baseline: digest(baseline),
    current: digest(current),
    actions,
    network,
    console: {
      baselineCount: baselineConsole.length,
      currentCount: currentConsole.length,
      sampleNew: consoleNew,
    },
    exceptions: {
      baselineCount: baselineExc.length,
      currentCount: currentExc.length,
      sampleNew: exceptionsNew,
    },
    finalUrl: {
      baseline: baselineFinalUrl,
      current: currentFinalUrl,
      match: baselineFinalUrl === currentFinalUrl,
    },
    navigations: {
      baselineCount: baseline.summary.navigations.length,
      currentCount: current.summary.navigations.length,
    },
  }
}

function digest(s: StoredSession): SessionDiff['baseline'] {
  return {
    id: s.id,
    startedAt: s.summary.meta.startedAt,
    uploadedAt: s.uploadedAt,
    host: s.summary.meta.host,
    durationMs: s.summary.meta.durationMs,
  }
}

function lastNavigationUrl(summary: SessionSummary): string | null {
  const navs = summary.navigations
  return navs.length > 0 ? navs[navs.length - 1]!.url : null
}

// Identity used for LCS: two actions are "the same" if their action type
// AND their best stable identifier (primary selector / roleName / text)
// match. This catches reordering and shifting without being fooled by a
// new comment line in the test.
function actionKey(a: SerializedAction): string {
  const sel = a.selector
  const id = sel.roleName ?? sel.alternatives.testId ?? sel.alternatives.text ?? sel.alternatives.css ?? sel.primary
  return `${a.type}:${(id ?? '').slice(0, 80)}`
}

function diffActions(a: SerializedAction[], b: SerializedAction[]): ActionDiff {
  // Classic LCS DP — n*m table, then walk back to emit ops.
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    const ka = actionKey(a[i - 1]!)
    for (let j = 1; j <= m; j++) {
      const kb = actionKey(b[j - 1]!)
      dp[i]![j] = ka === kb ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }
  const ops: ActionOp[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && actionKey(a[i - 1]!) === actionKey(b[j - 1]!)) {
      ops.unshift({ kind: 'keep', baseline: a[i - 1]!, current: b[j - 1]! })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.unshift({ kind: 'add', current: b[j - 1]! })
      j--
    } else {
      ops.unshift({ kind: 'remove', baseline: a[i - 1]! })
      i--
    }
  }
  return { total: { baseline: n, current: m }, ops }
}

function diffNetwork(
  a: SessionSummary['significantResponses'],
  b: SessionSummary['significantResponses'],
): NetworkDiff {
  const baselineByUrl = new Map<string, NetworkEntry>()
  const currentByUrl = new Map<string, NetworkEntry>()
  for (const r of a) baselineByUrl.set(r.url, { url: r.url, method: r.method, status: r.status, mimeType: r.mimeType })
  for (const r of b) currentByUrl.set(r.url, { url: r.url, method: r.method, status: r.status, mimeType: r.mimeType })

  const common: NetworkEntry[] = []
  const onlyInBaseline: NetworkEntry[] = []
  const onlyInCurrent: NetworkEntry[] = []
  const statusChanged: NetworkDiff['statusChanged'] = []

  for (const [url, base] of baselineByUrl) {
    const cur = currentByUrl.get(url)
    if (!cur) onlyInBaseline.push(base)
    else {
      common.push(cur)
      if (cur.status !== base.status) {
        statusChanged.push({ url, method: cur.method ?? base.method, baselineStatus: base.status, currentStatus: cur.status })
      }
    }
  }
  for (const [url, cur] of currentByUrl) {
    if (!baselineByUrl.has(url)) onlyInCurrent.push(cur)
  }

  return { common, onlyInBaseline, onlyInCurrent, statusChanged }
}
