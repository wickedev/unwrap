import type { TestRun } from './storage/test-runs'

export interface SpecStability {
  // Unique spec key — file + title.
  key: string
  file: string
  title: string
  totalRuns: number
  passes: number
  fails: number
  flakes: number
  skips: number
  // 0..1 — passes / (passes + fails + flakes). Higher = more stable.
  passRate: number
  // First run we saw this spec start failing on (so the UI can answer
  // "since when?"). null when it has never failed.
  firstFailureRunId: string | null
  firstFailureAt: number | null
  // The most recent error excerpt — useful for the table view.
  latestErrorMessage?: string
  // Classification — flaky if the spec has ≥1 pass AND ≥1 fail in the
  // last 10 runs; failing-consistently if last 3 runs all failed.
  status: 'stable' | 'flaky' | 'failing' | 'unknown'
}

export interface ProjectTestStability {
  // Per-spec stability rolled up across the runs.
  specs: SpecStability[]
  // Headline counts.
  totalRuns: number
  flakyCount: number
  consistentlyFailingCount: number
  stableCount: number
}

const FLAKE_WINDOW = 10
const FAIL_STREAK = 3

// Reads the most recent N test runs (oldest-first ordering inside this
// function for streak detection) and rolls them up into per-spec
// stability. The runs list should come in newest-first; we walk it
// reversed for streak/first-failure detection.
export function analyzeTestStability(runs: TestRun[]): ProjectTestStability {
  // runs come in newest-first; reverse for chronological streak detection
  const chronological = runs.slice().reverse()
  const map = new Map<string, SpecStability & { recentStatuses: SpecStability['status'][] }>()

  for (const run of chronological) {
    for (const spec of run.specs) {
      const key = `${spec.file}::${spec.title}`
      let entry = map.get(key)
      if (!entry) {
        entry = {
          key,
          file: spec.file,
          title: spec.title,
          totalRuns: 0,
          passes: 0,
          fails: 0,
          flakes: 0,
          skips: 0,
          passRate: 0,
          firstFailureRunId: null,
          firstFailureAt: null,
          status: 'unknown',
          recentStatuses: [],
        }
        map.set(key, entry)
      }
      entry.totalRuns++
      if (spec.status === 'passed') entry.passes++
      else if (spec.status === 'failed') {
        entry.fails++
        if (!entry.firstFailureRunId) {
          entry.firstFailureRunId = run.id
          entry.firstFailureAt = run.uploadedAt
        }
        if (spec.errorMessage) entry.latestErrorMessage = spec.errorMessage
      }
      else if (spec.status === 'flaky') entry.flakes++
      else if (spec.status === 'skipped') entry.skips++
      // Track for stability classification.
      // We only care about pass/fail/flake for status windowing.
      if (spec.status === 'passed' || spec.status === 'failed' || spec.status === 'flaky') {
        entry.recentStatuses.push(spec.status === 'passed' ? 'stable' : spec.status === 'failed' ? 'failing' : 'flaky')
      }
    }
  }

  for (const entry of map.values()) {
    const denominator = entry.passes + entry.fails + entry.flakes
    entry.passRate = denominator === 0 ? 0 : entry.passes / denominator
    const window = entry.recentStatuses.slice(-FLAKE_WINDOW)
    const lastN = entry.recentStatuses.slice(-FAIL_STREAK)
    const failStreak = lastN.length >= FAIL_STREAK && lastN.every((s) => s === 'failing')
    const hasPassAndFailInWindow = window.includes('stable') && (window.includes('failing') || window.includes('flaky'))
    if (failStreak) entry.status = 'failing'
    else if (hasPassAndFailInWindow) entry.status = 'flaky'
    else if (window.length > 0 && window.every((s) => s === 'stable')) entry.status = 'stable'
    else entry.status = 'unknown'
  }

  const specs = [...map.values()]
    .map(({ recentStatuses: _r, ...rest }) => rest)
    .sort((a, b) => {
      const order = { failing: 0, flaky: 1, unknown: 2, stable: 3 }
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
      return a.passRate - b.passRate
    })

  return {
    specs,
    totalRuns: runs.length,
    flakyCount: specs.filter((s) => s.status === 'flaky').length,
    consistentlyFailingCount: specs.filter((s) => s.status === 'failing').length,
    stableCount: specs.filter((s) => s.status === 'stable').length,
  }
}
