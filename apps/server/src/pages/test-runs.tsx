import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import type { TestRun } from '../storage/test-runs'
import type { ProjectTestStability, SpecStability } from '../test-run-analysis'

const STATUS_PILL: Record<string, string> = {
  stable: 'bg-success/20 text-success',
  flaky: 'bg-warning/20 text-warning',
  failing: 'bg-danger/20 text-danger',
  unknown: 'bg-muted text-muted-foreground',
}

export function TestRunsPage({ email, host, runs, stability, ingestPath }: { email: string; host: string; runs: TestRun[]; stability: ProjectTestStability; ingestPath: string }) {
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Test runs</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Results from canonical-suite executions in CI, posted back to <code className="rounded bg-muted px-1.5 py-0.5">{ingestPath}</code>.
        Surfaces per-spec stability over time so flaky and consistently-failing tests stop hiding.
      </p>

      {runs.length === 0
        ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No test runs ingested yet.</p>
            <p className="text-xs mt-3">
              In your CI step, after <code className="rounded bg-muted px-1.5 py-0.5">npx playwright test --reporter=json</code> finishes,
              POST the resulting <code className="rounded bg-muted px-1.5 py-0.5">results.json</code> to{' '}
              <code className="rounded bg-muted px-1.5 py-0.5">{ingestPath}</code> with your Unwrap API token in the{' '}
              <code className="rounded bg-muted px-1.5 py-0.5">Authorization: Bearer …</code> header.
            </p>
            <p className="text-xs mt-2">Optional fields the ingest accepts: <code className="rounded bg-muted px-1.5 py-0.5">ci.gitSha</code>, <code className="rounded bg-muted px-1.5 py-0.5">ci.branch</code>, <code className="rounded bg-muted px-1.5 py-0.5">ci.prNumber</code>, <code className="rounded bg-muted px-1.5 py-0.5">ci.runUrl</code> — pass them as JSON keys so the UI can link back.</p>
          </div>
        )
        : (
          <>
            <Card className="mb-4">
              <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
                <Kpi label="Total runs" value={stability.totalRuns} color="text-primary" />
                <Kpi label="Stable specs" value={stability.stableCount} color="text-success" />
                <Kpi label="Flaky specs" value={stability.flakyCount} color={stability.flakyCount > 0 ? 'text-warning' : 'text-muted-foreground'} />
                <Kpi label="Failing specs" value={stability.consistentlyFailingCount} color={stability.consistentlyFailingCount > 0 ? 'text-danger' : 'text-muted-foreground'} />
              </CardContent>
            </Card>

            {stability.specs.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-semibold m-0 mb-2">Per-spec stability</h2>
                <Card className="overflow-hidden p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Spec</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Pass rate</TableHead>
                        <TableHead className="text-right">Runs</TableHead>
                        <TableHead>First failure</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{stability.specs.map((s, i) => <StabilityRow key={i} s={s} />)}</TableBody>
                  </Table>
                </Card>
              </section>
            )}

            <section className="mb-6">
              <h2 className="text-sm font-semibold m-0 mb-2">Recent runs ({runs.length})</h2>
              <Card className="overflow-hidden p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>CI</TableHead>
                      <TableHead className="text-right">Pass</TableHead>
                      <TableHead className="text-right">Fail</TableHead>
                      <TableHead className="text-right">Flaky</TableHead>
                      <TableHead className="text-right">Duration</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{runs.map((r) => <RunRow key={r.id} r={r} host={host} />)}</TableBody>
                </Table>
              </Card>
            </section>
          </>
        )}
    </Layout>
  )
}

function Kpi({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className={cn('text-lg font-semibold', color)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function StabilityRow({ s }: { s: SpecStability }) {
  const bgClass = s.status === 'failing' ? 'bg-danger/5' : s.status === 'flaky' ? 'bg-warning/5' : ''
  const rateColor = s.passRate >= 0.9 ? 'text-success' : s.passRate >= 0.5 ? 'text-warning' : 'text-danger'
  return (
    <TableRow className={bgClass}>
      <TableCell><code title={s.file}>{s.title}</code><div className="text-[10px] text-muted-foreground mt-0.5">{s.file}</div></TableCell>
      <TableCell><span className={cn('inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase', STATUS_PILL[s.status])}>{s.status}</span></TableCell>
      <TableCell className={cn('text-right font-semibold', rateColor)}>{Math.round(s.passRate * 100)}%</TableCell>
      <TableCell className="text-right">{s.totalRuns}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{s.firstFailureAt
        ? (
          <>
            {new Date(s.firstFailureAt).toISOString().slice(0, 16).replace('T', ' ')}
            {s.latestErrorMessage && <div className="text-[10px] mt-0.5">{truncate(s.latestErrorMessage, 70)}</div>}
          </>
        )
        : '—'}</TableCell>
    </TableRow>
  )
}

function RunRow({ r, host }: { r: TestRun; host: string }) {
  return (
    <TableRow>
      <TableCell><a href={`/projects/${encodeURIComponent(host)}/test-runs/${r.id}`} className="font-mono text-xs text-primary">{new Date(r.uploadedAt).toISOString().replace('T', ' ').slice(0, 16)}</a></TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {r.ci?.branch && <><code className="rounded bg-muted px-1 py-0.5">{r.ci.branch}</code>{' '}</>}
        {r.ci?.gitSha && <><code className="rounded bg-muted px-1 py-0.5">{r.ci.gitSha.slice(0, 7)}</code>{' '}</>}
        {r.ci?.prNumber && <>PR #{r.ci.prNumber}{' '}</>}
        {r.ci?.runUrl && <a href={r.ci.runUrl} target="_blank" rel="noopener" className="text-primary">↗</a>}
      </TableCell>
      <TableCell className={cn('text-right', r.totals.passed > 0 ? 'text-success' : 'text-muted-foreground')}>{r.totals.passed}</TableCell>
      <TableCell className={cn('text-right', r.totals.failed > 0 ? 'text-danger font-semibold' : 'text-muted-foreground')}>{r.totals.failed}</TableCell>
      <TableCell className={cn('text-right', r.totals.flaky > 0 ? 'text-warning' : 'text-muted-foreground')}>{r.totals.flaky}</TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">{formatDuration(r.totals.durationMs)}</TableCell>
    </TableRow>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}
