import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ProjectA11yReport, AggregatedFinding } from '../project-a11y'
import { titleFor, severityFor } from '../project-a11y'
import type { AccessibilityFinding, AccessibilityPageReport } from '@unwrap/protocol'

const SEV_COLOR = { high: '#d64545', warn: '#b88300', info: '#5e6772' } as const

export function ProjectA11yPage({
  email,
  host,
  report,
}: {
  email: string
  host: string
  report: ProjectA11yReport | null
}): Renderable {
  return Layout({
    title: `${host} · accessibility`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Accessibility findings</h2>
      <p class="muted">
        Heuristic audit derived from the CDP accessibility trees captured during each session.
        Runtime-based, so it reflects what the user actually saw — not a static scan of source.
        Highest-confidence findings only (missing accessible names on interactive elements,
        missing alt text, focusable but aria-hidden elements). Use a full audit suite
        (axe-core, Lighthouse) for comprehensive coverage.
      </p>

      ${!report
        ? html`<div class="empty">
            <p>No accessibility data captured for this project yet.</p>
            <p style="margin-top: 12px; font-size: 12px;">
              AX tree summaries are computed at upload time from the captured tree blobs.
              If you're seeing this on a real project, the captures were likely made before
              the a11y summary feature shipped — reload the extension and record one fresh
              session.
            </p>
          </div>`
        : html`
          <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin-bottom: 16px;">
            ${kpi('Pages scanned', report.pages.length, '#2f6feb')}
            ${kpi('Total findings', report.totals.reduce((n, t) => n + t.totalCount, 0), kpiColor(report.totals))}
            ${kpi('High-sev kinds', report.totals.filter((t) => severityFor(t.kind) === 'high').length, '#d64545')}
            ${kpi('Sessions w/ AX', `${report.sessionsWithAxData}/${report.sessionCountTotal}`, 'var(--muted)')}
          </div>

          ${report.totals.length === 0
            ? html`<div class="empty">No findings — every heuristic came back clean. (Or there's nothing interactive on the captured pages.)</div>`
            : html`
              <div class="section">
                <h2>Findings (rolled up across pages)</h2>
                ${report.totals.map((t) => renderTotal(t))}
              </div>

              <div class="section">
                <h2>Per-page breakdown (top ${Math.min(report.pages.length, 30)} worst)</h2>
                <div class="card" style="padding: 0;">
                  <table class="a11y-table">
                    <thead>
                      <tr>
                        <th>Page</th>
                        <th style="text-align: right;">Findings</th>
                        <th style="text-align: right;">Nodes</th>
                        <th>Breakdown</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${report.pages.slice(0, 30).map((p) => renderPageRow(p))}
                    </tbody>
                  </table>
                </div>
              </div>
            `}
        `}

      <style>${raw(A11Y_CSS)}</style>
    `,
  })
}

function renderTotal(t: AggregatedFinding): Renderable {
  const sev = severityFor(t.kind)
  return html`<div class="a11y-finding sev-${sev}">
    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px;">
      <span class="sev-pill" style="background-color: ${SEV_COLOR[sev]};">${sev}</span>
      <strong>${titleFor(t.kind)}</strong>
      <span class="meta" style="font-size: 11px; margin-left: auto;">${t.totalCount} instance${t.totalCount === 1 ? '' : 's'} · ${t.pageCount} page${t.pageCount === 1 ? '' : 's'}</span>
    </div>
    ${t.evidence.length > 0
      ? html`<details>
          <summary class="muted" style="font-size: 11px;">show ${t.evidence.length} sample${t.evidence.length === 1 ? '' : 's'}</summary>
          <ul class="evidence">
            ${t.evidence.map((e) => html`<li><code>${e}</code></li>`)}
          </ul>
        </details>`
      : ''}
  </div>`
}

function renderPageRow(p: AccessibilityPageReport): Renderable {
  const total = p.findings.reduce((n, f) => n + f.count, 0)
  return html`<tr>
    <td><code title="${p.url}">${truncateUrl(p.url, 72)}</code></td>
    <td style="text-align: right; color: ${total === 0 ? 'var(--muted)' : '#d64545'}; font-weight: 600;">${total}</td>
    <td style="text-align: right;" class="meta">${p.nodeCount}</td>
    <td>${p.findings.length === 0
      ? html`<span class="meta" style="font-size: 11px;">clean</span>`
      : html`<span style="font-size: 11px;">${p.findings.map((f: AccessibilityFinding) => html`<span class="kind-pill" style="background-color: ${SEV_COLOR[severityFor(f.kind)]};">${f.kind} ×${f.count}</span>`)}</span>`}</td>
  </tr>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function kpiColor(totals: AggregatedFinding[]): string {
  if (totals.some((t) => severityFor(t.kind) === 'high')) return '#d64545'
  if (totals.some((t) => severityFor(t.kind) === 'warn')) return '#b88300'
  return 'var(--muted)'
}

function truncateUrl(url: string, n: number): string {
  if (url.length <= n) return url
  return url.slice(0, n / 2 - 1) + '…' + url.slice(url.length - n / 2 + 1)
}

const A11Y_CSS = `
.a11y-finding { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
.a11y-finding.sev-high { border-color: color-mix(in oklab, #d64545 35%, var(--border)); background: color-mix(in oklab, #d64545 4%, transparent); }
.a11y-finding.sev-warn { border-color: color-mix(in oklab, #b88300 35%, var(--border)); background: color-mix(in oklab, #b88300 4%, transparent); }
.a11y-finding .sev-pill { color: white; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.a11y-finding .evidence { list-style: none; padding-left: 0; margin: 8px 0 0; }
.a11y-finding .evidence li { padding: 2px 0; font-size: 11px; }
.a11y-finding .evidence code { font-size: 11px; }
.a11y-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.a11y-table th, .a11y-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.a11y-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.a11y-table tr:last-child td { border-bottom: 0; }
.a11y-table code { font-size: 11px; word-break: break-all; }
.kind-pill { color: white; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-right: 4px; display: inline-block; margin-bottom: 2px; }
`
