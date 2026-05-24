import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ProjectCoverage } from '../project-coverage'
import type { CoverageFile } from '@unwrap/protocol'

export function ProjectCoveragePage({
  email,
  host,
  coverage,
}: {
  email: string
  host: string
  coverage: ProjectCoverage | null
}): Renderable {
  return Layout({
    title: `${host} · coverage`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Code coverage & dead-code map</h2>
      <p class="muted">
        Per-file used vs. total bytes from V8 PreciseCoverage (JS) and CSS rule usage,
        aggregated across every captured session that recorded coverage. "Used" is the
        maximum we ever saw — i.e., the fullest exercise of that file across all
        recorded user flows.
      </p>

      ${!coverage
        ? html`<div class="empty">
            <p>No coverage data captured yet.</p>
            <p style="margin-top: 12px; font-size: 12px;">
              The extension captures coverage automatically — if you're seeing this on a
              real project, the captures were likely made before the coverage summary
              feature shipped, or the Profiler / CSS CDP domain failed to attach during
              recording. Try reloading the extension and recording a fresh session.
            </p>
          </div>`
        : html`
          <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-bottom: 16px;">
            ${kpi('JS used', formatBytes(coverage.jsUsedBytes), '#1f9d55')}
            ${kpi('JS total', formatBytes(coverage.jsTotalBytes), 'var(--fg)')}
            ${kpi('JS used %', percent(coverage.jsUsedBytes, coverage.jsTotalBytes), pickColor(coverage.jsUsedBytes, coverage.jsTotalBytes))}
            ${kpi('CSS used', formatBytes(coverage.cssUsedBytes), '#1f9d55')}
            ${kpi('CSS total', formatBytes(coverage.cssTotalBytes), 'var(--fg)')}
            ${kpi('CSS used %', percent(coverage.cssUsedBytes, coverage.cssTotalBytes), pickColor(coverage.cssUsedBytes, coverage.cssTotalBytes))}
          </div>

          <div class="meta" style="margin-bottom: 12px; font-size: 12px;">
            Coverage captured in <strong>${coverage.sessionsWithCoverage}</strong> of <strong>${coverage.sessionCountTotal}</strong> session${coverage.sessionCountTotal === 1 ? '' : 's'}.
            ${coverage.sessionsWithCoverage < coverage.sessionCountTotal
              ? html`The remaining sessions don't have coverage data — possibly from before the feature landed.`
              : ''}
          </div>

          <div class="section">
            <h2>Heaviest files (top ${Math.min(coverage.files.length, 40)} by total size)</h2>
            <div class="card" style="padding: 0; overflow: hidden;">
              <table class="cov-table">
                <thead>
                  <tr>
                    <th style="text-align: left;">URL</th>
                    <th style="text-align: right;">Kind</th>
                    <th style="text-align: right;">Used</th>
                    <th style="text-align: right;">Total</th>
                    <th style="text-align: right;">%</th>
                    <th style="text-align: right;">Dead</th>
                    <th style="width: 180px;">Bar</th>
                  </tr>
                </thead>
                <tbody>
                  ${coverage.files.slice(0, 40).map((f) => renderRow(f))}
                </tbody>
              </table>
            </div>
            ${coverage.files.length > 40
              ? html`<div class="meta" style="margin-top: 6px; font-size: 11px;">…and ${coverage.files.length - 40} smaller file${coverage.files.length - 40 === 1 ? '' : 's'} not shown.</div>`
              : ''}
          </div>
        `}

      <style>${raw(COVERAGE_CSS)}</style>
    `,
  })
}

function renderRow(f: CoverageFile): Renderable {
  const pct = f.totalBytes > 0 ? f.usedBytes / f.totalBytes : 0
  const dead = f.totalBytes - f.usedBytes
  const color = colorForRatio(pct)
  return html`<tr>
    <td><code title="${f.url}">${truncate(prettyUrl(f.url), 64)}</code></td>
    <td style="text-align: right;"><span class="badge kind-${f.kind}">${f.kind}</span></td>
    <td style="text-align: right;">${formatBytes(f.usedBytes)}</td>
    <td style="text-align: right;">${formatBytes(f.totalBytes)}</td>
    <td style="text-align: right; color: ${color}; font-weight: 600;">${Math.round(pct * 100)}%</td>
    <td style="text-align: right; color: ${dead > 100_000 ? '#d64545' : 'var(--muted)'};">${formatBytes(dead)}</td>
    <td><div class="cov-bar"><div class="cov-bar-used" style="width: ${(pct * 100).toFixed(1)}%; background: ${color};"></div></div></td>
  </tr>`
}

function kpi(label: string, value: string | number, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function percent(used: number, total: number): string {
  if (total === 0) return '—'
  return `${Math.round((used / total) * 100)}%`
}

function pickColor(used: number, total: number): string {
  if (total === 0) return 'var(--muted)'
  return colorForRatio(used / total)
}

function colorForRatio(r: number): string {
  if (r >= 0.7) return '#1f9d55'
  if (r >= 0.4) return '#b88300'
  return '#d64545'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : '…' + s.slice(s.length - n + 1)
}

function prettyUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.host + u.pathname
  } catch {
    return url
  }
}

const COVERAGE_CSS = `
.cov-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.cov-table th, .cov-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
.cov-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; }
.cov-table tr:last-child td { border-bottom: 0; }
.cov-table code { font-size: 11px; word-break: break-all; }
.badge.kind-js { background: #b88300; color: white; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.badge.kind-css { background: #2f6feb; color: white; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.cov-bar { height: 8px; background: rgba(127,127,127,0.12); border-radius: 4px; overflow: hidden; }
.cov-bar-used { height: 100%; }
`
