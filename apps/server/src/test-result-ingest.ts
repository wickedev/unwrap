import type { TestRun, TestSpecResult } from './storage/test-runs'

// Accepts either Playwright's JSON reporter shape (a tree of suites
// containing specs containing tests) or a flat "specs" array shape for
// callers that hand-roll the upload. Both produce the same internal
// TestRun.

interface IngestBody {
  host?: string
  ci?: TestRun['ci']
  // Playwright JSON reporter top-level. Either this OR `specs` is required.
  config?: unknown
  suites?: PwSuite[]
  // Flat alternative.
  specs?: TestSpecResult[]
  // Optional pre-computed duration; we'll fall back to summing.
  durationMs?: number
}

interface PwSuite {
  title?: string
  file?: string
  specs?: PwSpec[]
  suites?: PwSuite[]
}

interface PwSpec {
  title?: string
  file?: string
  tests?: PwTest[]
}

interface PwTest {
  status?: string
  results?: PwResult[]
  // 'expected', 'unexpected', 'flaky', 'skipped' from Playwright
  outcome?: 'expected' | 'unexpected' | 'flaky' | 'skipped'
}

interface PwResult {
  status?: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
  duration?: number
  errors?: { message?: string; stack?: string }[]
  error?: { message?: string; stack?: string }
}

export interface NormalizedTestRun extends Omit<TestRun, 'id'> {
  // Caller supplies the id (storage helpers assign one) — but during
  // normalization we don't have one yet.
}

export function normalizeTestRunIngest(body: unknown): NormalizedTestRun | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' }
  const b = body as IngestBody
  const host = b.host
  if (!host) return { error: 'host required' }

  let specs: TestSpecResult[]
  if (Array.isArray(b.specs) && b.specs.length > 0) {
    specs = b.specs
      .map((s) => normalizeFlatSpec(s))
      .filter((s): s is TestSpecResult => s !== null)
  } else if (Array.isArray(b.suites)) {
    specs = flattenPlaywrightSuites(b.suites)
  } else {
    return { error: 'either specs[] or suites[] required' }
  }
  if (specs.length === 0) return { error: 'no test results found in payload' }

  const totals = {
    passed: specs.filter((s) => s.status === 'passed').length,
    failed: specs.filter((s) => s.status === 'failed').length,
    skipped: specs.filter((s) => s.status === 'skipped').length,
    flaky: specs.filter((s) => s.status === 'flaky').length,
    durationMs: typeof b.durationMs === 'number'
      ? b.durationMs
      : specs.reduce((n, s) => n + (s.durationMs || 0), 0),
  }

  return {
    host,
    uploadedAt: Date.now(),
    ...(b.ci ? { ci: b.ci } : {}),
    specs,
    totals,
  }
}

function normalizeFlatSpec(s: Partial<TestSpecResult>): TestSpecResult | null {
  if (!s.file || !s.title || !s.status) return null
  if (!['passed', 'failed', 'skipped', 'flaky'].includes(s.status)) return null
  return {
    file: s.file,
    title: s.title,
    status: s.status,
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
    ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
    ...(s.errorStack ? { errorStack: s.errorStack } : {}),
  }
}

function flattenPlaywrightSuites(suites: PwSuite[], filePrefix?: string): TestSpecResult[] {
  const out: TestSpecResult[] = []
  for (const suite of suites) {
    const file = suite.file ?? filePrefix ?? '(unknown)'
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const result = test.results?.[test.results.length - 1] // last attempt's outcome
        const outcome = test.outcome
        const status = mapPwStatus(outcome, result?.status)
        const error = result?.errors?.[0] ?? result?.error
        const entry: TestSpecResult = {
          file: spec.file ?? file,
          title: spec.title ?? '(untitled)',
          status,
          durationMs: result?.duration ?? 0,
          ...(error?.message ? { errorMessage: error.message.split('\n')[0]!.slice(0, 800) } : {}),
          ...(error?.stack ? { errorStack: error.stack.slice(0, 4000) } : {}),
        }
        out.push(entry)
      }
    }
    if (suite.suites && suite.suites.length > 0) {
      out.push(...flattenPlaywrightSuites(suite.suites, file))
    }
  }
  return out
}

function mapPwStatus(outcome?: string, lastStatus?: string): TestSpecResult['status'] {
  if (outcome === 'flaky') return 'flaky'
  if (outcome === 'skipped' || lastStatus === 'skipped') return 'skipped'
  if (outcome === 'unexpected' || lastStatus === 'failed' || lastStatus === 'timedOut') return 'failed'
  if (outcome === 'expected' || lastStatus === 'passed') return 'passed'
  return 'failed'
}
