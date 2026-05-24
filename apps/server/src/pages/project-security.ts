import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { SecurityReport, SecurityFinding, AuthMatrixRow } from '../project-security'

const SEV_COLOR: Record<SecurityFinding['severity'], string> = {
  high: '#d64545',
  warn: '#b88300',
  info: '#5e6772',
}

const SEV_GLYPH: Record<SecurityFinding['severity'], string> = {
  high: '⚠',
  warn: '!',
  info: 'i',
}

export function ProjectSecurityPage({
  email,
  report,
}: {
  email: string
  report: SecurityReport
}): Renderable {
  return Layout({
    title: `${report.host} · security`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(report.host)}">← back to ${report.host}</a></p>
      <h2 style="margin-top: 4px;">Security overview</h2>
      <p class="muted">
        Heuristic findings derived from captured network, navigation, and storage data.
        This is signal for further investigation — not a conformance check, and not a substitute
        for a proper security audit. The extension redacts sensitive header VALUES but preserves
        NAMES, so auth-scheme detection is possible without ever shipping the secrets.
      </p>

      <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 16px;">
        ${kpi('Sessions', report.sessionCount, 'var(--fg)')}
        ${kpi('Endpoints', report.totals.endpoints, '#2f6feb')}
        ${kpi('Auth-protected', report.totals.authedEndpoints, '#1f9d55')}
        ${kpi('Cookies seen', report.totals.cookies, '#7c4ac2')}
        ${kpi('Cross-origin', report.totals.crossOriginRequests, '#b88300')}
        ${kpi('Findings', report.findings.length, kpiColor(report.findings))}
      </div>

      ${report.findings.length === 0
        ? html`<div class="empty">No findings — nothing matched the heuristics. Could also mean the captures didn't include enough data (try recording a session that exercises auth / mutation flows).</div>`
        : html`
          <div class="section">
            <h2>Findings (${report.findings.length})</h2>
            ${report.findings.map((f) => renderFinding(f))}
          </div>
        `}

      ${report.authMatrix.length > 0
        ? html`<div class="section">
            <h2>Auth matrix (per endpoint)</h2>
            <div class="card" style="padding: 0; overflow: hidden;">
              <table class="sec-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Auth scheme</th>
                    <th style="text-align: right;">Calls</th>
                    <th style="text-align: right;">401</th>
                    <th style="text-align: right;">403</th>
                  </tr>
                </thead>
                <tbody>
                  ${report.authMatrix.map((r) => renderMatrixRow(r))}
                </tbody>
              </table>
            </div>
          </div>`
        : ''}

      <style>${raw(SEC_CSS)}</style>
    `,
  })
}

function renderFinding(f: SecurityFinding): Renderable {
  return html`<div class="finding sev-${f.severity}">
    <div class="finding-head">
      <span class="sev-pill" style="background-color: ${SEV_COLOR[f.severity]};">${SEV_GLYPH[f.severity]} ${f.severity}</span>
      <strong>${f.title}</strong>
    </div>
    <div class="finding-body">
      <p>${f.description}</p>
      ${f.evidence.length > 0
        ? html`<ul class="evidence">
            ${f.evidence.map((e) => html`<li><code>${e}</code></li>`)}
          </ul>`
        : ''}
    </div>
  </div>`
}

function renderMatrixRow(r: AuthMatrixRow): Renderable {
  const schemeColor = r.scheme === '(none)' ? 'var(--muted)' : r.scheme === 'Mixed' ? '#b88300' : '#1f9d55'
  return html`<tr>
    <td><span class="method m-${r.method.toLowerCase()}">${r.method}</span></td>
    <td><code>${r.normalizedPath}</code></td>
    <td style="color: ${schemeColor}; font-weight: 600;">${r.scheme}</td>
    <td style="text-align: right;">${r.callCount}</td>
    <td style="text-align: right; ${r.unauthorizedHits > 0 ? 'color: #d64545;' : 'color: var(--muted);'}">${r.unauthorizedHits || ''}</td>
    <td style="text-align: right; ${r.forbiddenHits > 0 ? 'color: #d64545;' : 'color: var(--muted);'}">${r.forbiddenHits || ''}</td>
  </tr>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function kpiColor(findings: SecurityFinding[]): string {
  if (findings.some((f) => f.severity === 'high')) return '#d64545'
  if (findings.some((f) => f.severity === 'warn')) return '#b88300'
  return 'var(--muted)'
}

const SEC_CSS = `
.finding { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
.finding.sev-high { border-color: color-mix(in oklab, #d64545 35%, var(--border)); background: color-mix(in oklab, #d64545 4%, transparent); }
.finding.sev-warn { border-color: color-mix(in oklab, #b88300 35%, var(--border)); background: color-mix(in oklab, #b88300 4%, transparent); }
.finding-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.sev-pill { color: white; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.finding-body p { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.finding-body .evidence { list-style: none; padding: 0; margin: 0; }
.finding-body .evidence li { padding: 3px 0; font-size: 11px; }
.finding-body .evidence code { font-size: 11px; word-break: break-all; }
.sec-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sec-table th, .sec-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
.sec-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.sec-table tr:last-child td { border-bottom: 0; }
.sec-table code { font-size: 11px; word-break: break-all; }
.method { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; color: white; }
.method.m-get { background: #2f6feb; }
.method.m-post { background: #1f9d55; }
.method.m-put, .method.m-patch { background: #b88300; }
.method.m-delete { background: #d64545; }
.method:not(.m-get):not(.m-post):not(.m-put):not(.m-patch):not(.m-delete) { background: #8c8c8c; }
`
