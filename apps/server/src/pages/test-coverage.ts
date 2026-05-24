import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { TestCoverage, RouteCoverage, EndpointCoverage } from '../test-coverage'

export function TestCoveragePage({
  email,
  host,
  coverage,
}: {
  email: string
  host: string
  coverage: TestCoverage
}): Renderable {
  const untestedRoutes = coverage.routes.filter((r) => r.coveringSpecs.length === 0)
  const untestedEndpoints = coverage.endpoints.filter((e) => e.coveringSpecs.length === 0)
  const routePct = coverage.routesTotalCount === 0 ? 0 : coverage.routesCoveredCount / coverage.routesTotalCount
  const epPct = coverage.endpointsTotalCount === 0 ? 0 : coverage.endpointsCoveredCount / coverage.endpointsTotalCount

  return Layout({
    title: `${host} · test coverage`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Test coverage map</h2>
      <p class="muted">
        Cross-references the project's known surface (every route and endpoint captured) against
        every generated Playwright spec, to surface what's tested and — more usefully — what isn't.
        Endpoint coverage is transitive: a spec covers an endpoint if it visits a page that
        historically fires that endpoint (derived from the same page→endpoint graph the dependency
        view uses).
      </p>

      <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin-bottom: 16px;">
        ${kpi('Specs', coverage.specs.length, '#2f6feb')}
        ${kpi('Routes covered', `${coverage.routesCoveredCount} / ${coverage.routesTotalCount}`, colorForPct(routePct))}
        ${kpi('Endpoints covered', `${coverage.endpointsCoveredCount} / ${coverage.endpointsTotalCount}`, colorForPct(epPct))}
        ${kpi('Untested routes', untestedRoutes.length, untestedRoutes.length === 0 ? '#1f9d55' : '#d64545')}
        ${kpi('Untested endpoints', untestedEndpoints.length, untestedEndpoints.length === 0 ? '#1f9d55' : '#d64545')}
      </div>

      ${coverage.specs.length === 0
        ? html`<div class="empty">
            <p>No generated Playwright specs in this project yet.</p>
            <p style="margin-top: 12px; font-size: 12px;">
              Open a session detail page and click "Generate AI test" to mint a spec.
              Coverage shows up here automatically once any session has a spec.
            </p>
          </div>`
        : html`
          ${untestedRoutes.length > 0
            ? html`<div class="section">
                <h2>Untested routes — prioritized by traffic</h2>
                <p class="muted" style="font-size: 12px;">These routes were navigated to during recording but no spec exercises them. Sorted by visit count desc; tackle the top of the list first.</p>
                <div class="card" style="padding: 0; overflow: hidden;">
                  <table class="cov-table">
                    <thead>
                      <tr>
                        <th>Route</th>
                        <th style="text-align: right;">Visits</th>
                        <th style="text-align: right;">Sessions</th>
                        <th style="text-align: right;">Example URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${untestedRoutes.slice(0, 30).map((r) => renderUntestedRoute(r))}
                    </tbody>
                  </table>
                </div>
              </div>`
            : html`<div class="section">
                <h2>Untested routes</h2>
                <div class="card"><div class="muted">Every captured route has at least one spec exercising it. 🎉</div></div>
              </div>`}

          ${untestedEndpoints.length > 0
            ? html`<div class="section">
                <h2>Untested endpoints — prioritized by call volume</h2>
                <p class="muted" style="font-size: 12px;">These endpoints fired during recording but no spec visits any page that uses them. Often a fast win — write a spec for the most-used untested endpoint's "owner page".</p>
                <div class="card" style="padding: 0; overflow: hidden;">
                  <table class="cov-table">
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th>Path</th>
                        <th style="text-align: right;">Calls</th>
                      </tr>
                    </thead>
                    <tbody>${untestedEndpoints.slice(0, 30).map((e) => renderUntestedEndpoint(e))}</tbody>
                  </table>
                </div>
              </div>`
            : ''}

          <div class="section">
            <h2>All routes (covered + untested)</h2>
            <div class="card" style="padding: 0; overflow: hidden;">
              <table class="cov-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th style="text-align: right;">Visits</th>
                    <th style="text-align: right;">Specs covering</th>
                  </tr>
                </thead>
                <tbody>${coverage.routes.map((r) => renderRouteRow(r))}</tbody>
              </table>
            </div>
          </div>

          <div class="section">
            <h2>All specs (${coverage.specs.length})</h2>
            <div class="card" style="padding: 0; overflow: hidden;">
              <table class="cov-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th style="text-align: right;">Routes touched</th>
                    <th>Visited routes</th>
                  </tr>
                </thead>
                <tbody>
                  ${coverage.specs.map((s) => html`<tr>
                    <td><a href="/sessions/${s.sessionId}" style="font-family: ui-monospace, monospace; font-size: 11px;">${s.sessionId.slice(0, 8)}</a></td>
                    <td style="text-align: right;">${s.visitedRoutes.length}</td>
                    <td><div style="font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all;">${s.visitedRoutes.slice(0, 6).join(', ')}${s.visitedRoutes.length > 6 ? ` …+${s.visitedRoutes.length - 6}` : ''}</div></td>
                  </tr>`)}
                </tbody>
              </table>
            </div>
          </div>
        `}

      <style>${raw(COV_CSS)}</style>
    `,
  })
}

function renderUntestedRoute(r: RouteCoverage): Renderable {
  return html`<tr class="untested">
    <td><code>${r.normalizedPath}</code></td>
    <td style="text-align: right;">${r.visitCount}</td>
    <td style="text-align: right;">${r.sessionCount}</td>
    <td style="text-align: right;"><code title="${r.exampleUrl}" style="font-size: 11px;">${truncate(r.exampleUrl, 60)}</code></td>
  </tr>`
}

function renderUntestedEndpoint(e: EndpointCoverage): Renderable {
  return html`<tr class="untested">
    <td><span class="method m-${e.method.toLowerCase()}">${e.method}</span></td>
    <td><code>${e.normalizedPath}</code></td>
    <td style="text-align: right;">${e.callCount}</td>
  </tr>`
}

function renderRouteRow(r: RouteCoverage): Renderable {
  const covered = r.coveringSpecs.length > 0
  return html`<tr class="${covered ? 'covered' : 'untested'}">
    <td><code>${r.normalizedPath}</code></td>
    <td style="text-align: right;">${r.visitCount}</td>
    <td style="text-align: right;">${covered
      ? html`<span style="color: #1f9d55; font-weight: 600;">${r.coveringSpecs.length}</span>`
      : html`<span class="muted">0</span>`}</td>
  </tr>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function colorForPct(p: number): string {
  if (p >= 0.7) return '#1f9d55'
  if (p >= 0.3) return '#b88300'
  return '#d64545'
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

const COV_CSS = `
.cov-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.cov-table th, .cov-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
.cov-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.cov-table tr.untested td { background: color-mix(in oklab, #d64545 4%, transparent); }
.cov-table tr:last-child td { border-bottom: 0; }
.cov-table code { font-size: 11px; word-break: break-all; }
.method { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; color: white; font-family: ui-monospace, monospace; }
.method.m-get { background: #2f6feb; }
.method.m-post { background: #1f9d55; }
.method.m-put, .method.m-patch { background: #b88300; }
.method.m-delete { background: #d64545; }
.method:not(.m-get):not(.m-post):not(.m-put):not(.m-patch):not(.m-delete) { background: #8c8c8c; }
`
