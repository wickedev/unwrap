import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { PerformanceReport, EndpointPerf, SlowCall, N1Pattern } from '../project-performance'

export function ProjectPerformancePage({
  email,
  host,
  report,
}: {
  email: string
  host: string
  report: PerformanceReport
}): Renderable {
  const hasData = report.callsWithLatency > 0

  return Layout({
    title: `${host} · performance`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Performance</h2>
      <p class="muted">
        Per-endpoint latency rolled up across every captured session. Latency = request issuance →
        response body fully received, derived from the captured CDP timestamps. p50/p90/p95 are
        computed over the union of calls observed; the per-call detail of which session a hit came
        from is preserved for the "slowest calls" table so you can navigate to the exact recording.
      </p>

      ${!hasData
        ? html`<div class="empty">
            <p>No latency data captured for this project yet.</p>
            <p style="margin-top: 12px; font-size: 12px;">
              The extension started recording latency on captured API calls in the last release.
              Reload the extension and record one new session, or run a CLI capture, to populate.
            </p>
          </div>`
        : html`
          <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin-bottom: 16px;">
            ${kpi('Endpoints', report.endpoints.length, '#2f6feb')}
            ${kpi('Calls (with latency)', report.callsWithLatency, 'var(--fg)')}
            ${kpi('Sessions w/ data', `${report.sessionsWithLatency}/${report.sessionCountTotal}`, 'var(--muted)')}
            ${kpi('N+1 suspects', report.n1Suspects.length, report.n1Suspects.length === 0 ? 'var(--muted)' : '#b88300')}
            ${kpi('Slowest call', formatMs(report.slowestCalls[0]?.latencyMs ?? 0), (report.slowestCalls[0]?.latencyMs ?? 0) > 1000 ? '#d64545' : 'var(--fg)')}
          </div>

          ${report.n1Suspects.length > 0
            ? html`<div class="section">
                <h2>N+1 suspects</h2>
                <div class="card" style="padding: 0; overflow: hidden;">
                  <table class="perf-table">
                    <thead>
                      <tr>
                        <th>Endpoint</th>
                        <th style="text-align: right;">Max burst</th>
                        <th style="text-align: right;">Burst span</th>
                        <th style="text-align: right;">Occurrences</th>
                        <th>Example session</th>
                      </tr>
                    </thead>
                    <tbody>${report.n1Suspects.map((p) => renderN1(p))}</tbody>
                  </table>
                </div>
                <div class="meta" style="font-size: 11px; margin-top: 6px;">Heuristic: ≥4 hits to the same endpoint within 1 second on the same session. False-positive on legitimate fast polling.</div>
              </div>`
            : ''}

          <div class="section">
            <h2>Endpoints by p95 latency</h2>
            <div class="card" style="padding: 0; overflow: hidden;">
              <table class="perf-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th style="text-align: right;">Calls</th>
                    <th style="text-align: right;">p50</th>
                    <th style="text-align: right;">p90</th>
                    <th style="text-align: right;">p95</th>
                    <th style="text-align: right;">Max</th>
                    <th style="text-align: right;">Errors</th>
                  </tr>
                </thead>
                <tbody>${report.endpoints.map((e) => renderEndpoint(e))}</tbody>
              </table>
            </div>
          </div>

          ${report.slowestCalls.length > 0
            ? html`<div class="section">
                <h2>Slowest individual calls</h2>
                <div class="card" style="padding: 0; overflow: hidden;">
                  <table class="perf-table">
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th>URL</th>
                        <th style="text-align: right;">Status</th>
                        <th style="text-align: right;">Latency</th>
                        <th>Session</th>
                      </tr>
                    </thead>
                    <tbody>${report.slowestCalls.map((c) => renderSlowCall(c))}</tbody>
                  </table>
                </div>
              </div>`
            : ''}
        `}

      <style>${raw(PERF_CSS)}</style>
    `,
  })
}

function renderN1(p: N1Pattern): Renderable {
  return html`<tr>
    <td><code>${p.endpoint}</code></td>
    <td style="text-align: right; color: #b88300; font-weight: 600;">${p.maxBurstSize}</td>
    <td style="text-align: right;">${formatMs(p.maxBurstSpanMs)}</td>
    <td style="text-align: right;">${p.occurrences}</td>
    <td><a href="/sessions/${p.exampleSessionId}" style="font-family: ui-monospace, monospace; font-size: 11px;">${p.exampleSessionId.slice(0, 8)}</a></td>
  </tr>`
}

function renderEndpoint(e: EndpointPerf): Renderable {
  const errRate = e.callCount > 0 ? e.errorCount / e.callCount : 0
  return html`<tr>
    <td><span class="method m-${e.method.toLowerCase()}">${e.method}</span></td>
    <td><code>${e.normalizedPath}</code></td>
    <td style="text-align: right;">${e.callCount}</td>
    <td style="text-align: right;">${formatMs(e.p50)}</td>
    <td style="text-align: right;">${formatMs(e.p90)}</td>
    <td style="text-align: right; color: ${colorForLatency(e.p95)}; font-weight: 600;">${formatMs(e.p95)}</td>
    <td style="text-align: right; color: ${colorForLatency(e.max)}; font-weight: 600;">${formatMs(e.max)}</td>
    <td style="text-align: right; ${errRate > 0 ? `color: ${errRate > 0.05 ? '#d64545' : '#b88300'};` : 'color: var(--muted);'}">${e.errorCount}${errRate > 0 ? html` <span class="meta">(${Math.round(errRate * 100)}%)</span>` : ''}</td>
  </tr>`
}

function renderSlowCall(c: SlowCall): Renderable {
  return html`<tr>
    <td><span class="method m-${c.method.toLowerCase()}">${c.method}</span></td>
    <td><code title="${c.url}">${truncate(c.url, 90)}</code></td>
    <td style="text-align: right; ${c.status >= 400 ? 'color: #d64545; font-weight: 600;' : ''}">${c.status}</td>
    <td style="text-align: right; color: ${colorForLatency(c.latencyMs)}; font-weight: 600;">${formatMs(c.latencyMs)}</td>
    <td><a href="/sessions/${c.sessionId}" style="font-family: ui-monospace, monospace; font-size: 11px;">${c.sessionId.slice(0, 8)}</a></td>
  </tr>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function colorForLatency(ms: number): string {
  if (ms > 3000) return '#d64545'
  if (ms > 1000) return '#b88300'
  if (ms > 300) return 'var(--fg)'
  return '#1f9d55'
}

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

const PERF_CSS = `
.perf-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.perf-table th, .perf-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
.perf-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.perf-table tr:last-child td { border-bottom: 0; }
.perf-table code { font-size: 11px; word-break: break-all; }
.method { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; color: white; font-family: ui-monospace, monospace; }
.method.m-get { background: #2f6feb; }
.method.m-post { background: #1f9d55; }
.method.m-put, .method.m-patch { background: #b88300; }
.method.m-delete { background: #d64545; }
.method:not(.m-get):not(.m-post):not(.m-put):not(.m-patch):not(.m-delete) { background: #8c8c8c; }
`
