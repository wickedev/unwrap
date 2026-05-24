import { Layout } from './_layout'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/ui/table'
import { cn } from '../components/lib/cn'
import type { ProjectA11yReport, AggregatedFinding } from '../project-a11y'
import { titleFor, severityFor } from '../project-a11y'
import type { AccessibilityFinding, AccessibilityPageReport } from '@unwrap/protocol'

const SEV_VARIANT: Record<'high' | 'warn' | 'info', 'danger' | 'warning' | 'muted'> = { high: 'danger', warn: 'warning', info: 'muted' }
const SEV_BG: Record<'high' | 'warn' | 'info', string> = { high: 'bg-[hsl(var(--danger))]', warn: 'bg-[hsl(var(--warning))]', info: 'bg-gray-500' }

export function ProjectA11yPage({ email, host, report }: { email: string; host: string; report: ProjectA11yReport | null }) {
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Accessibility findings</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Heuristic audit derived from the CDP accessibility trees captured during each session.
        Runtime-based, so it reflects what the user actually saw — not a static scan of source.
      </p>

      {!report
        ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No accessibility data captured for this project yet.</p>
            <p className="text-xs mt-2">AX tree summaries are computed at upload time from the captured tree blobs. Reload the extension and record one fresh session.</p>
          </div>
        )
        : (
          <>
            <Card className="mb-4">
              <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
                <Kpi label="Pages scanned" value={report.pages.length} color="text-[hsl(var(--primary))]" />
                <Kpi label="Total findings" value={report.totals.reduce((n, t) => n + t.totalCount, 0)} color={kpiColor(report.totals)} />
                <Kpi label="High-sev kinds" value={report.totals.filter((t) => severityFor(t.kind) === 'high').length} color="text-[hsl(var(--danger))]" />
                <Kpi label="Sessions w/ AX" value={`${report.sessionsWithAxData}/${report.sessionCountTotal}`} color="text-muted-foreground" />
              </CardContent>
            </Card>

            {report.totals.length === 0
              ? <div className="text-center text-muted-foreground py-12">No findings — every heuristic came back clean.</div>
              : (
                <>
                  <section className="mb-6">
                    <h2 className="text-sm font-semibold m-0 mb-3">Findings (rolled up across pages)</h2>
                    <div className="space-y-2">{report.totals.map((t, i) => <Total key={i} t={t} />)}</div>
                  </section>

                  <section className="mb-6">
                    <h2 className="text-sm font-semibold m-0 mb-3">Per-page breakdown (top {Math.min(report.pages.length, 30)} worst)</h2>
                    <Card className="overflow-hidden p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Page</TableHead>
                            <TableHead className="text-right">Findings</TableHead>
                            <TableHead className="text-right">Nodes</TableHead>
                            <TableHead>Breakdown</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>{report.pages.slice(0, 30).map((p) => <PageRow key={p.url} p={p} />)}</TableBody>
                      </Table>
                    </Card>
                  </section>
                </>
              )}
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

function Total({ t }: { t: AggregatedFinding }) {
  const sev = severityFor(t.kind)
  return (
    <div className={cn(
      'rounded-lg border p-3.5',
      sev === 'high' && 'border-[hsl(var(--danger))]/35 bg-[hsl(var(--danger))]/5',
      sev === 'warn' && 'border-[hsl(var(--warning))]/35 bg-[hsl(var(--warning))]/5',
    )}>
      <div className="flex gap-2 items-center mb-1.5 flex-wrap">
        <Badge variant={SEV_VARIANT[sev]}>{sev}</Badge>
        <strong>{titleFor(t.kind)}</strong>
        <span className="text-xs text-muted-foreground ml-auto">{t.totalCount} instance{t.totalCount === 1 ? '' : 's'} · {t.pageCount} page{t.pageCount === 1 ? '' : 's'}</span>
      </div>
      {t.evidence.length > 0 && (
        <details>
          <summary className="text-xs text-muted-foreground cursor-pointer">show {t.evidence.length} sample{t.evidence.length === 1 ? '' : 's'}</summary>
          <ul className="mt-2 list-none p-0 space-y-0.5">
            {t.evidence.map((e, i) => <li key={i} className="text-xs"><code>{e}</code></li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

function PageRow({ p }: { p: AccessibilityPageReport }) {
  const total = p.findings.reduce((n, f) => n + f.count, 0)
  return (
    <TableRow>
      <TableCell><code title={p.url}>{truncateUrl(p.url, 72)}</code></TableCell>
      <TableCell className={cn('text-right font-semibold', total === 0 ? 'text-muted-foreground' : 'text-[hsl(var(--danger))]')}>{total}</TableCell>
      <TableCell className="text-right text-muted-foreground">{p.nodeCount}</TableCell>
      <TableCell>
        {p.findings.length === 0
          ? <span className="text-xs text-muted-foreground">clean</span>
          : (
            <span className="text-xs">
              {p.findings.map((f: AccessibilityFinding, i: number) => (
                <span key={i} className={cn('inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold text-white mr-1 mb-0.5', SEV_BG[severityFor(f.kind)])}>{f.kind} ×{f.count}</span>
              ))}
            </span>
          )}
      </TableCell>
    </TableRow>
  )
}

function kpiColor(totals: AggregatedFinding[]): string {
  if (totals.some((t) => severityFor(t.kind) === 'high')) return 'text-[hsl(var(--danger))]'
  if (totals.some((t) => severityFor(t.kind) === 'warn')) return 'text-[hsl(var(--warning))]'
  return 'text-muted-foreground'
}

function truncateUrl(url: string, n: number) {
  if (url.length <= n) return url
  return url.slice(0, n / 2 - 1) + '…' + url.slice(url.length - n / 2 + 1)
}
