import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { cn } from '@unwrap/ui'
import type { ProjectCoverage } from '../project-coverage'
import type { CoverageFile } from '@unwrap/protocol'

export function ProjectCoveragePage({ email, host, coverage }: { email: string; host: string; coverage: ProjectCoverage | null }) {
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Code coverage & dead-code map</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Per-file used vs. total bytes from V8 PreciseCoverage (JS) and CSS rule usage, aggregated across every captured session.
        "Used" is the maximum we ever saw — i.e., the fullest exercise of that file across all recorded user flows.
      </p>

      {!coverage
        ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No coverage data captured yet.</p>
            <p className="text-xs mt-2">Reload the extension and record a fresh session — Profiler / CSS CDP domain failures during recording also produce empty coverage.</p>
          </div>
        )
        : (
          <>
            <Card className="mb-4">
              <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
                <Kpi label="JS used" value={formatBytes(coverage.jsUsedBytes)} color="text-success" />
                <Kpi label="JS total" value={formatBytes(coverage.jsTotalBytes)} color="text-foreground" />
                <Kpi label="JS used %" value={percent(coverage.jsUsedBytes, coverage.jsTotalBytes)} color={pickColor(coverage.jsUsedBytes, coverage.jsTotalBytes)} />
                <Kpi label="CSS used" value={formatBytes(coverage.cssUsedBytes)} color="text-success" />
                <Kpi label="CSS total" value={formatBytes(coverage.cssTotalBytes)} color="text-foreground" />
                <Kpi label="CSS used %" value={percent(coverage.cssUsedBytes, coverage.cssTotalBytes)} color={pickColor(coverage.cssUsedBytes, coverage.cssTotalBytes)} />
              </CardContent>
            </Card>

            <div className="text-xs text-muted-foreground mb-3">
              Coverage captured in <strong>{coverage.sessionsWithCoverage}</strong> of <strong>{coverage.sessionCountTotal}</strong> session{coverage.sessionCountTotal === 1 ? '' : 's'}.
              {coverage.sessionsWithCoverage < coverage.sessionCountTotal && ' The remaining sessions don\'t have coverage data — possibly from before the feature landed.'}
            </div>

            <section className="mb-6">
              <h2 className="text-sm font-semibold m-0 mb-3">Heaviest files (top {Math.min(coverage.files.length, 40)} by total size)</h2>
              <Card className="overflow-hidden p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>URL</TableHead>
                      <TableHead className="text-right">Kind</TableHead>
                      <TableHead className="text-right">Used</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">%</TableHead>
                      <TableHead className="text-right">Dead</TableHead>
                      <TableHead className="w-[180px]">Bar</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{coverage.files.slice(0, 40).map((f, i) => <FileRow key={i} f={f} />)}</TableBody>
                </Table>
              </Card>
              {coverage.files.length > 40 && (
                <div className="text-xs text-muted-foreground mt-1.5">…and {coverage.files.length - 40} smaller file{coverage.files.length - 40 === 1 ? '' : 's'} not shown.</div>
              )}
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

function FileRow({ f }: { f: CoverageFile }) {
  const pct = f.totalBytes > 0 ? f.usedBytes / f.totalBytes : 0
  const dead = f.totalBytes - f.usedBytes
  const cls = colorClass(pct)
  return (
    <TableRow>
      <TableCell><code title={f.url}>{truncate(prettyUrl(f.url), 64)}</code></TableCell>
      <TableCell className="text-right">
        <span className={cn('inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase text-white', f.kind === 'js' ? 'bg-warning' : 'bg-primary')}>{f.kind}</span>
      </TableCell>
      <TableCell className="text-right">{formatBytes(f.usedBytes)}</TableCell>
      <TableCell className="text-right">{formatBytes(f.totalBytes)}</TableCell>
      <TableCell className={cn('text-right font-semibold', cls)}>{Math.round(pct * 100)}%</TableCell>
      <TableCell className={cn('text-right', dead > 100_000 ? 'text-danger' : 'text-muted-foreground')}>{formatBytes(dead)}</TableCell>
      <TableCell>
        <div className="h-2 bg-muted rounded overflow-hidden">
          <div className={cn('h-full', barClass(pct))} style={{ width: `${(pct * 100).toFixed(1)}%` }} />
        </div>
      </TableCell>
    </TableRow>
  )
}

function colorClass(r: number) {
  if (r >= 0.7) return 'text-success'
  if (r >= 0.4) return 'text-warning'
  return 'text-danger'
}
function barClass(r: number) {
  if (r >= 0.7) return 'bg-success'
  if (r >= 0.4) return 'bg-warning'
  return 'bg-danger'
}
function percent(used: number, total: number) {
  if (total === 0) return '—'
  return `${Math.round((used / total) * 100)}%`
}
function pickColor(used: number, total: number) {
  if (total === 0) return 'text-muted-foreground'
  return colorClass(used / total)
}
function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
function truncate(s: string, n: number) {
  return s.length <= n ? s : '…' + s.slice(s.length - n + 1)
}
function prettyUrl(url: string) {
  try { const u = new URL(url); return u.host + u.pathname } catch { return url }
}
