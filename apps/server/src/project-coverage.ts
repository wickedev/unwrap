import type { CoverageFile, CoverageSummary, StoredSession } from '@unwrap/protocol'

export interface ProjectCoverage {
  // Aggregate totals across every session that had coverage.
  jsUsedBytes: number
  jsTotalBytes: number
  cssUsedBytes: number
  cssTotalBytes: number
  // Per-URL merged file rows. For each file we take MAX(usedBytes) and
  // MAX(totalBytes) across sessions — captures the best-case execution
  // coverage. Min would let early-bailout sessions distort the picture.
  files: CoverageFile[]
  // How many sessions contributed coverage data.
  sessionsWithCoverage: number
  sessionCountTotal: number
}

// Merges coverage summaries across every session that captured one.
// Per-file we keep the maximum used/total we ever saw — represents the
// fullest exercise of that file across all recorded user flows.
export function aggregateCoverage(sessions: StoredSession[]): ProjectCoverage | null {
  const withCoverage = sessions.filter((s) => s.summary.coverage)
  if (withCoverage.length === 0) return null

  const byUrl = new Map<string, CoverageFile>()
  for (const s of withCoverage) {
    const cov = s.summary.coverage as CoverageSummary
    for (const f of cov.files) {
      const existing = byUrl.get(f.url)
      if (!existing) {
        byUrl.set(f.url, { ...f })
      } else {
        existing.usedBytes = Math.max(existing.usedBytes, f.usedBytes)
        existing.totalBytes = Math.max(existing.totalBytes, f.totalBytes)
      }
    }
  }

  const files = [...byUrl.values()].sort((a, b) => b.totalBytes - a.totalBytes)
  let jsUsed = 0, jsTotal = 0, cssUsed = 0, cssTotal = 0
  for (const f of files) {
    if (f.kind === 'js') { jsUsed += f.usedBytes; jsTotal += f.totalBytes }
    else { cssUsed += f.usedBytes; cssTotal += f.totalBytes }
  }

  return {
    jsUsedBytes: jsUsed,
    jsTotalBytes: jsTotal,
    cssUsedBytes: cssUsed,
    cssTotalBytes: cssTotal,
    files,
    sessionsWithCoverage: withCoverage.length,
    sessionCountTotal: sessions.length,
  }
}
