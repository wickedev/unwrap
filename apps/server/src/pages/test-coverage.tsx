import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@unwrap/ui'
import { MethodPill } from './project'
import { cn } from '@unwrap/ui'
import type { TestCoverage, RouteCoverage, EndpointCoverage } from '../test-coverage'

export function TestCoveragePage({ email, host, coverage }: { email: string; host: string; coverage: TestCoverage }) {
  const untestedRoutes = coverage.routes.filter((r) => r.coveringSpecs.length === 0)
  const untestedEndpoints = coverage.endpoints.filter((e) => e.coveringSpecs.length === 0)
  const routePct = coverage.routesTotalCount === 0 ? 0 : coverage.routesCoveredCount / coverage.routesTotalCount
  const epPct = coverage.endpointsTotalCount === 0 ? 0 : coverage.endpointsCoveredCount / coverage.endpointsTotalCount
  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/projects/${encodeURIComponent(host)}`} className="text-primary text-sm">← back to {host}</a></p>
      <h2 className="m-0 text-xl font-bold">Test coverage map</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Cross-references the project's known surface (every route and endpoint captured) against every generated Playwright spec, to surface what's tested and — more usefully — what isn't.
        Endpoint coverage is transitive: a spec covers an endpoint if it visits a page that historically fires that endpoint.
      </p>

      <Card className="mb-4">
        <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
          <Kpi label="Specs" value={coverage.specs.length} color="text-primary" />
          <Kpi label="Routes covered" value={`${coverage.routesCoveredCount} / ${coverage.routesTotalCount}`} color={colorForPct(routePct)} />
          <Kpi label="Endpoints covered" value={`${coverage.endpointsCoveredCount} / ${coverage.endpointsTotalCount}`} color={colorForPct(epPct)} />
          <Kpi label="Untested routes" value={untestedRoutes.length} color={untestedRoutes.length === 0 ? 'text-success' : 'text-danger'} />
          <Kpi label="Untested endpoints" value={untestedEndpoints.length} color={untestedEndpoints.length === 0 ? 'text-success' : 'text-danger'} />
        </CardContent>
      </Card>

      {coverage.specs.length === 0
        ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No generated Playwright specs in this project yet.</p>
            <p className="text-xs mt-3">Open a session detail page and click "Generate AI test" to mint a spec. Coverage shows up here automatically once any session has a spec.</p>
          </div>
        )
        : (
          <>
            <section className="mb-6">
              <h2 className="text-sm font-semibold m-0 mb-2">{untestedRoutes.length > 0 ? 'Untested routes — prioritized by traffic' : 'Untested routes'}</h2>
              {untestedRoutes.length > 0
                ? (
                  <>
                    <p className="text-xs text-muted-foreground mb-2">These routes were navigated to during recording but no spec exercises them. Sorted by visit count desc; tackle the top of the list first.</p>
                    <Card className="overflow-hidden p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Route</TableHead>
                            <TableHead className="text-right">Visits</TableHead>
                            <TableHead className="text-right">Sessions</TableHead>
                            <TableHead className="text-right">Example URL</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>{untestedRoutes.slice(0, 30).map((r, i) => <UntestedRouteRow key={i} r={r} />)}</TableBody>
                      </Table>
                    </Card>
                  </>
                )
                : <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Every captured route has at least one spec exercising it. 🎉</div></CardContent></Card>}
            </section>

            {untestedEndpoints.length > 0 && (
              <section className="mb-6">
                <h2 className="text-sm font-semibold m-0 mb-2">Untested endpoints — prioritized by call volume</h2>
                <p className="text-xs text-muted-foreground mb-2">These endpoints fired during recording but no spec visits any page that uses them. Often a fast win — write a spec for the most-used untested endpoint's "owner page".</p>
                <Card className="overflow-hidden p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Method</TableHead>
                        <TableHead>Path</TableHead>
                        <TableHead className="text-right">Calls</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>{untestedEndpoints.slice(0, 30).map((e, i) => <UntestedEndpointRow key={i} e={e} />)}</TableBody>
                  </Table>
                </Card>
              </section>
            )}

            <section className="mb-6">
              <h2 className="text-sm font-semibold m-0 mb-2">All routes (covered + untested)</h2>
              <Card className="overflow-hidden p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Route</TableHead>
                      <TableHead className="text-right">Visits</TableHead>
                      <TableHead className="text-right">Specs covering</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{coverage.routes.map((r, i) => <RouteRow key={i} r={r} />)}</TableBody>
                </Table>
              </Card>
            </section>

            <section className="mb-6">
              <h2 className="text-sm font-semibold m-0 mb-2">All specs ({coverage.specs.length})</h2>
              <Card className="overflow-hidden p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Session</TableHead>
                      <TableHead className="text-right">Routes touched</TableHead>
                      <TableHead>Visited routes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {coverage.specs.map((s, i) => (
                      <TableRow key={i}>
                        <TableCell><a href={`/sessions/${s.sessionId}`} className="font-mono text-xs text-primary">{s.sessionId.slice(0, 8)}</a></TableCell>
                        <TableCell className="text-right">{s.visitedRoutes.length}</TableCell>
                        <TableCell><div className="font-mono text-xs break-all">{s.visitedRoutes.slice(0, 6).join(', ')}{s.visitedRoutes.length > 6 ? ` …+${s.visitedRoutes.length - 6}` : ''}</div></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
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

function UntestedRouteRow({ r }: { r: RouteCoverage }) {
  return (
    <TableRow className="bg-danger/5">
      <TableCell><code>{r.normalizedPath}</code></TableCell>
      <TableCell className="text-right">{r.visitCount}</TableCell>
      <TableCell className="text-right">{r.sessionCount}</TableCell>
      <TableCell className="text-right"><code title={r.exampleUrl} className="text-xs">{truncate(r.exampleUrl, 60)}</code></TableCell>
    </TableRow>
  )
}

function UntestedEndpointRow({ e }: { e: EndpointCoverage }) {
  return (
    <TableRow className="bg-danger/5">
      <TableCell><MethodPill method={e.method} /></TableCell>
      <TableCell><code>{e.normalizedPath}</code></TableCell>
      <TableCell className="text-right">{e.callCount}</TableCell>
    </TableRow>
  )
}

function RouteRow({ r }: { r: RouteCoverage }) {
  const covered = r.coveringSpecs.length > 0
  return (
    <TableRow className={covered ? '' : 'bg-danger/5'}>
      <TableCell><code>{r.normalizedPath}</code></TableCell>
      <TableCell className="text-right">{r.visitCount}</TableCell>
      <TableCell className="text-right">{covered
        ? <span className="text-success font-semibold">{r.coveringSpecs.length}</span>
        : <span className="text-muted-foreground">0</span>}</TableCell>
    </TableRow>
  )
}

function colorForPct(p: number): string {
  if (p >= 0.7) return 'text-success'
  if (p >= 0.3) return 'text-warning'
  return 'text-danger'
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
