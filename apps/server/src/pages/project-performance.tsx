import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { MethodPill } from './project'
import { cn } from '@unwrap/ui'
import type { PerformanceReport, EndpointPerf, SlowCall, N1Pattern } from '../project-performance'

export function ProjectPerformancePage({ email, host, report }: { email: string; host: string; report: PerformanceReport }) {
  const hasData = report.callsWithLatency > 0
  const slowestMs = report.slowestCalls[0]?.latencyMs ?? 0
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Performance</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Per-endpoint latency rolled up across every captured session. Latency = request issuance → response body fully received, from captured CDP timestamps. p50/p90/p95 over the union of calls observed.
      </p>

      {!hasData
        ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No latency data captured for this project yet.</p>
            <p className="text-xs mt-2">Reload the extension and record one new session, or run a CLI capture.</p>
          </div>
        )
        : (
          <>
            <Card className="mb-4">
              <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
                <Kpi label="Endpoints" value={report.endpoints.length} color="text-primary" />
                <Kpi label="Calls (with latency)" value={report.callsWithLatency} color="text-foreground" />
                <Kpi label="Sessions w/ data" value={`${report.sessionsWithLatency}/${report.sessionCountTotal}`} color="text-muted-foreground" />
                <Kpi label="N+1 suspects" value={report.n1Suspects.length} color={report.n1Suspects.length === 0 ? 'text-muted-foreground' : 'text-warning'} />
                <Kpi label="Slowest call" value={formatMs(slowestMs)} color={slowestMs > 1000 ? 'text-danger' : 'text-foreground'} />
              </CardContent>
            </Card>

            {report.n1Suspects.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-semibold m-0 mb-3">N+1 suspects</h2>
                <Card className="overflow-hidden p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Endpoint</TableHead>
                        <TableHead className="text-right">Max burst</TableHead>
                        <TableHead className="text-right">Burst span</TableHead>
                        <TableHead className="text-right">Occurrences</TableHead>
                        <TableHead>Example session</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{report.n1Suspects.map((p, i) => <N1Row key={i} p={p} />)}</TableBody>
                  </Table>
                </Card>
                <div className="text-xs text-muted-foreground mt-1.5">Heuristic: ≥4 hits to the same endpoint within 1 second on the same session. False-positive on legitimate fast polling.</div>
              </section>
            )}

            <section className="mb-6">
              <h2 className="text-sm font-semibold m-0 mb-3">Endpoints by p95 latency</h2>
              <Card className="overflow-hidden p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Method</TableHead>
                      <TableHead>Path</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">p50</TableHead>
                      <TableHead className="text-right">p90</TableHead>
                      <TableHead className="text-right">p95</TableHead>
                      <TableHead className="text-right">Max</TableHead>
                      <TableHead className="text-right">Errors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{report.endpoints.map((e, i) => <EndpointRow key={i} e={e} />)}</TableBody>
                </Table>
              </Card>
            </section>

            {report.slowestCalls.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-semibold m-0 mb-3">Slowest individual calls</h2>
                <Card className="overflow-hidden p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Method</TableHead>
                        <TableHead>URL</TableHead>
                        <TableHead className="text-right">Status</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead>Session</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{report.slowestCalls.map((c, i) => <SlowCallRow key={i} c={c} />)}</TableBody>
                  </Table>
                </Card>
              </section>
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

function N1Row({ p }: { p: N1Pattern }) {
  return (
    <TableRow>
      <TableCell><code>{p.endpoint}</code></TableCell>
      <TableCell className="text-right font-semibold text-warning">{p.maxBurstSize}</TableCell>
      <TableCell className="text-right">{formatMs(p.maxBurstSpanMs)}</TableCell>
      <TableCell className="text-right">{p.occurrences}</TableCell>
      <TableCell><a href={`/sessions/${p.exampleSessionId}`} className="font-mono text-xs text-primary">{p.exampleSessionId.slice(0, 8)}</a></TableCell>
    </TableRow>
  )
}

function EndpointRow({ e }: { e: EndpointPerf }) {
  const errRate = e.callCount > 0 ? e.errorCount / e.callCount : 0
  return (
    <TableRow>
      <TableCell><MethodPill method={e.method} /></TableCell>
      <TableCell><code>{e.normalizedPath}</code></TableCell>
      <TableCell className="text-right">{e.callCount}</TableCell>
      <TableCell className="text-right">{formatMs(e.p50)}</TableCell>
      <TableCell className="text-right">{formatMs(e.p90)}</TableCell>
      <TableCell className={cn('text-right font-semibold', colorClassForLatency(e.p95))}>{formatMs(e.p95)}</TableCell>
      <TableCell className={cn('text-right font-semibold', colorClassForLatency(e.max))}>{formatMs(e.max)}</TableCell>
      <TableCell className={cn('text-right', errRate > 0 ? (errRate > 0.05 ? 'text-danger' : 'text-warning') : 'text-muted-foreground')}>
        {e.errorCount}{errRate > 0 && <span className="text-muted-foreground ml-1">({Math.round(errRate * 100)}%)</span>}
      </TableCell>
    </TableRow>
  )
}

function SlowCallRow({ c }: { c: SlowCall }) {
  return (
    <TableRow>
      <TableCell><MethodPill method={c.method} /></TableCell>
      <TableCell><code title={c.url}>{truncate(c.url, 90)}</code></TableCell>
      <TableCell className={cn('text-right', c.status >= 400 && 'text-danger font-semibold')}>{c.status}</TableCell>
      <TableCell className={cn('text-right font-semibold', colorClassForLatency(c.latencyMs))}>{formatMs(c.latencyMs)}</TableCell>
      <TableCell><a href={`/sessions/${c.sessionId}`} className="font-mono text-xs text-primary">{c.sessionId.slice(0, 8)}</a></TableCell>
    </TableRow>
  )
}

function colorClassForLatency(ms: number): string {
  if (ms > 3000) return 'text-danger'
  if (ms > 1000) return 'text-warning'
  if (ms > 300) return 'text-foreground'
  return 'text-success'
}
function formatMs(ms: number) {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
