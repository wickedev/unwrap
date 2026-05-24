import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { TestRun } from '../storage/test-runs'
import type { ProjectTestStability, SpecStability } from '../test-run-analysis'

export function TestRunsPage({
  email,
  host,
  runs,
  stability,
  ingestPath,
}: {
  email: string
  host: string
  runs: TestRun[]
  stability: ProjectTestStability
  ingestPath: string
}): Renderable {
  return Layout({
    title: `${host} · test runs`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Test runs</h2>
      <p class="muted">
        Results from canonical-suite executions in CI, posted back to <code>${ingestPath}</code>.
        Surfaces per-spec stability over time so flaky and consistently-failing tests stop hiding.
      </p>

      ${runs.length === 0
        ? html`<div class="empty">
            <p>No test runs ingested yet.</p>
            <p style="margin-top: 12px; font-size: 12px;">
              In your CI step, after <code>npx playwright test --reporter=json</code> finishes,
              POST the resulting <code>results.json</code> to
              <code>${ingestPath}</code> with your Unwrap API token in the
              <code>Authorization: Bearer …</code> header.
            </p>
            <p class="meta" style="font-size: 11px; margin-top: 8px;">Optional fields the ingest accepts: <code>ci.gitSha</code>, <code>ci.branch</code>, <code>ci.prNumber</code>, <code>ci.runUrl</code> — pass them as JSON keys so the UI can link back.</p>
          </div>`
        : html`
          <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 16px;">
            ${kpi('Total runs', stability.totalRuns, '#2f6feb')}
            ${kpi('Stable specs', stability.stableCount, '#1f9d55')}
            ${kpi('Flaky specs', stability.flakyCount, stability.flakyCount > 0 ? '#b88300' : 'var(--muted)')}
            ${kpi('Failing specs', stability.consistentlyFailingCount, stability.consistentlyFailingCount > 0 ? '#d64545' : 'var(--muted)')}
          </div>

          ${stability.specs.length > 0
            ? html`<div class="section">
                <h2>Per-spec stability</h2>
                <div class="card" style="padding: 0; overflow: hidden;">
                  <table class="runs-table">
                    <thead>
                      <tr>
                        <th>Spec</th>
                        <th>Status</th>
                        <th style="text-align: right;">Pass rate</th>
                        <th style="text-align: right;">Runs</th>
                        <th>First failure</th>
                      </tr>
                    </thead>
                    <tbody>${stability.specs.map((s) => renderStability(s))}</tbody>
                  </table>
                </div>
              </div>`
            : ''}

          <div class="section">
            <h2>Recent runs (${runs.length})</h2>
            <div class="card" style="padding: 0; overflow: hidden;">
              <table class="runs-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>CI</th>
                    <th style="text-align: right;">Pass</th>
                    <th style="text-align: right;">Fail</th>
                    <th style="text-align: right;">Flaky</th>
                    <th style="text-align: right;">Duration</th>
                  </tr>
                </thead>
                <tbody>${runs.map((r) => renderRun(r, host))}</tbody>
              </table>
            </div>
          </div>
        `}

      <style>${raw(RUNS_CSS)}</style>
    `,
  })
}

function renderStability(s: SpecStability): Renderable {
  return html`<tr class="status-${s.status}">
    <td><code title="${s.file}">${s.title}</code><div class="meta" style="font-size: 10px;">${s.file}</div></td>
    <td><span class="status-pill status-pill-${s.status}">${s.status}</span></td>
    <td style="text-align: right; color: ${s.passRate >= 0.9 ? '#1f9d55' : s.passRate >= 0.5 ? '#b88300' : '#d64545'}; font-weight: 600;">${Math.round(s.passRate * 100)}%</td>
    <td style="text-align: right;">${s.totalRuns}</td>
    <td class="meta">${s.firstFailureAt
      ? html`${new Date(s.firstFailureAt).toISOString().slice(0, 16).replace('T', ' ')} ${s.latestErrorMessage ? html`<div style="font-size: 10px;">${truncate(s.latestErrorMessage, 70)}</div>` : ''}`
      : '—'}</td>
  </tr>`
}

function renderRun(r: TestRun, host: string): Renderable {
  return html`<tr>
    <td><a href="/projects/${encodeURIComponent(host)}/test-runs/${r.id}" class="meta" style="font-family: ui-monospace, monospace; font-size: 11px;">${new Date(r.uploadedAt).toISOString().replace('T', ' ').slice(0, 16)}</a></td>
    <td class="meta" style="font-size: 11px;">
      ${r.ci?.branch ? html`<code>${r.ci.branch}</code> ` : ''}
      ${r.ci?.gitSha ? html`<code>${r.ci.gitSha.slice(0, 7)}</code> ` : ''}
      ${r.ci?.prNumber ? html`PR #${r.ci.prNumber}` : ''}
      ${r.ci?.runUrl ? html` <a href="${r.ci.runUrl}" target="_blank" rel="noopener">↗</a>` : ''}
    </td>
    <td style="text-align: right; color: ${r.totals.passed > 0 ? '#1f9d55' : 'var(--muted)'};">${r.totals.passed}</td>
    <td style="text-align: right; color: ${r.totals.failed > 0 ? '#d64545; font-weight: 600;' : 'var(--muted)'};">${r.totals.failed}</td>
    <td style="text-align: right; color: ${r.totals.flaky > 0 ? '#b88300' : 'var(--muted)'};">${r.totals.flaky}</td>
    <td style="text-align: right;" class="meta">${formatDuration(r.totals.durationMs)}</td>
  </tr>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
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

const RUNS_CSS = `
.runs-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.runs-table th, .runs-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
.runs-table th { background: rgba(127,127,127,0.05); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; text-align: left; }
.runs-table tr:last-child td { border-bottom: 0; }
.runs-table code { font-size: 11px; word-break: break-all; }
.runs-table tr.status-failing td { background: color-mix(in oklab, #d64545 5%, transparent); }
.runs-table tr.status-flaky td { background: color-mix(in oklab, #b88300 5%, transparent); }
.status-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.status-pill-stable { background: color-mix(in oklab, #1f9d55 20%, transparent); color: #1f9d55; }
.status-pill-flaky { background: color-mix(in oklab, #b88300 20%, transparent); color: #b88300; }
.status-pill-failing { background: color-mix(in oklab, #d64545 20%, transparent); color: #d64545; }
.status-pill-unknown { background: color-mix(in oklab, var(--muted) 20%, transparent); color: var(--muted); }
`
