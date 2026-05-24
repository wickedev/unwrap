import type { AccessibilityFinding, AccessibilityPageReport, StoredSession } from '@unwrap/protocol'

export interface ProjectA11yReport {
  host: string
  // Pages we have an AX tree for. Sorted by total finding count desc so
  // the worst pages float up. Each page keeps its own per-kind finding
  // list so the UI can show "X has 12 button-no-name; Y has 4 image-no-alt".
  pages: AccessibilityPageReport[]
  // Aggregate finding counts across the whole project, so the headline
  // KPIs tell you "12 button-no-name across the site, on 5 pages".
  totals: AggregatedFinding[]
  // Number of sessions that contributed AX data (rest sit silent).
  sessionsWithAxData: number
  sessionCountTotal: number
}

export interface AggregatedFinding {
  kind: AccessibilityFinding['kind']
  totalCount: number
  pageCount: number
  // Representative evidence picked across pages (max 12).
  evidence: string[]
}

const KIND_TITLES: Record<AccessibilityFinding['kind'], string> = {
  'button-no-name': 'Buttons without an accessible name',
  'link-no-name': 'Links without an accessible name',
  'image-no-alt': 'Images without alt text',
  'input-no-label': 'Form inputs without a label',
  'aria-hidden-focusable': 'Focusable elements marked aria-hidden',
  'heading-skip': 'Heading level skipped (h1 → h3)',
  'duplicate-aria-id': 'Duplicate element ids',
}

const KIND_SEVERITY: Record<AccessibilityFinding['kind'], 'high' | 'warn' | 'info'> = {
  'button-no-name': 'high',
  'link-no-name': 'high',
  'image-no-alt': 'warn',
  'input-no-label': 'high',
  'aria-hidden-focusable': 'high',
  'heading-skip': 'info',
  'duplicate-aria-id': 'warn',
}

export function titleFor(kind: AccessibilityFinding['kind']): string {
  return KIND_TITLES[kind]
}

export function severityFor(kind: AccessibilityFinding['kind']): 'high' | 'warn' | 'info' {
  return KIND_SEVERITY[kind]
}

// Aggregates per-session AccessibilityPageReports across the project,
// merging by URL and rolling up per-kind totals. Pages without AX data
// are silently excluded.
export function aggregateA11y(host: string, sessions: StoredSession[]): ProjectA11yReport | null {
  const sessionsWithAxData = sessions.filter((s) => (s.summary.accessibility?.length ?? 0) > 0)
  if (sessionsWithAxData.length === 0) return null

  const byUrl = new Map<string, AccessibilityPageReport>()
  for (const s of sessionsWithAxData) {
    for (const page of s.summary.accessibility!) {
      const existing = byUrl.get(page.url)
      if (!existing) {
        byUrl.set(page.url, {
          url: page.url,
          nodeCount: page.nodeCount,
          // Deep clone so subsequent merges don't mutate captured data.
          findings: page.findings.map((f) => ({ ...f, evidence: [...f.evidence] })),
        })
      } else {
        existing.nodeCount = Math.max(existing.nodeCount, page.nodeCount)
        mergePageFindings(existing, page)
      }
    }
  }

  // Per-page total finding count drives the sort.
  const pages = [...byUrl.values()].sort(
    (a, b) =>
      b.findings.reduce((n, f) => n + f.count, 0) - a.findings.reduce((n, f) => n + f.count, 0),
  )

  // Totals: each kind cumulates across pages with a page count.
  const totalsMap = new Map<AccessibilityFinding['kind'], AggregatedFinding>()
  for (const page of pages) {
    for (const f of page.findings) {
      const t = totalsMap.get(f.kind) ?? { kind: f.kind, totalCount: 0, pageCount: 0, evidence: [] }
      t.totalCount += f.count
      t.pageCount++
      for (const e of f.evidence) {
        if (t.evidence.length < 12 && !t.evidence.includes(e)) t.evidence.push(e)
      }
      totalsMap.set(f.kind, t)
    }
  }
  const totals = [...totalsMap.values()].sort((a, b) => severityRank(a.kind) - severityRank(b.kind) || b.totalCount - a.totalCount)

  return {
    host,
    pages,
    totals,
    sessionsWithAxData: sessionsWithAxData.length,
    sessionCountTotal: sessions.length,
  }
}

function mergePageFindings(into: AccessibilityPageReport, from: AccessibilityPageReport) {
  const byKind = new Map(into.findings.map((f) => [f.kind, f]))
  for (const f of from.findings) {
    const existing = byKind.get(f.kind)
    if (!existing) {
      into.findings.push({ ...f, evidence: [...f.evidence] })
      continue
    }
    existing.count = Math.max(existing.count, f.count)
    for (const e of f.evidence) {
      if (existing.evidence.length < 12 && !existing.evidence.includes(e)) existing.evidence.push(e)
    }
  }
  into.findings.sort((a, b) => b.count - a.count)
}

function severityRank(kind: AccessibilityFinding['kind']): number {
  return KIND_SEVERITY[kind] === 'high' ? 0 : KIND_SEVERITY[kind] === 'warn' ? 1 : 2
}
