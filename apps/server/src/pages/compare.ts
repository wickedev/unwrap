import { html } from 'hono/html'
import type { CrossSessionVisualDiff, CrossSessionVisualDiffPair } from '@unwrap/protocol'
import type { SessionDiff, ActionOp, NetworkDiff } from '../sessiondiff'
import { Layout, type Renderable } from './layout'

interface ComparePageProps {
  email: string
  diff: SessionDiff
  visual: CrossSessionVisualDiff | null
  // Where screenshot bytes live in storage. baseline screenshots live
  // under the baseline session, current + diff PNGs under the current.
  currentSessionId: string
  baselineSessionId: string
}

export function ComparePage({ email, diff, visual, currentSessionId, baselineSessionId }: ComparePageProps): Renderable {
  const a = diff.baseline
  const b = diff.current
  const added = diff.actions.ops.filter((o) => o.kind === 'add').length
  const removed = diff.actions.ops.filter((o) => o.kind === 'remove').length
  const kept = diff.actions.ops.filter((o) => o.kind === 'keep').length
  const consoleDelta = diff.console.currentCount - diff.console.baselineCount
  const exceptionDelta = diff.exceptions.currentCount - diff.exceptions.baselineCount
  const netDelta = diff.network.onlyInCurrent.length - diff.network.onlyInBaseline.length

  return Layout({
    title: 'Compare',
    email,
    body: html`
      <p>
        <a href="/sessions/${b.id}">← back to session ${b.id.slice(0, 8)}</a>
      </p>
      <h2 style="margin-top: 4px;">Session diff · ${b.host || '(no host)'}</h2>
      <p class="muted">Comparing the action trace, network responses, and error counts of two captured sessions.</p>

      <div class="section">
        <h2>Summary</h2>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          ${digestCard('Baseline (A)', a)}
          ${digestCard('Current (B)', b)}
        </div>
        <div class="card" style="margin-top: 12px;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;">
            ${kpiTile('Actions kept', kept, 'var(--muted)')}
            ${kpiTile('Actions added', added, added > 0 ? '#1f9d55' : 'var(--muted)')}
            ${kpiTile('Actions removed', removed, removed > 0 ? '#d64545' : 'var(--muted)')}
            ${kpiTile('Console errors', `${diff.console.baselineCount} → ${diff.console.currentCount}`, consoleDelta > 0 ? '#d64545' : 'var(--muted)')}
            ${kpiTile('Exceptions', `${diff.exceptions.baselineCount} → ${diff.exceptions.currentCount}`, exceptionDelta > 0 ? '#d64545' : 'var(--muted)')}
            ${kpiTile('Net responses Δ', netDelta > 0 ? `+${netDelta}` : `${netDelta}`, Math.abs(netDelta) > 0 ? '#b88300' : 'var(--muted)')}
            ${kpiTile('Final URL', diff.finalUrl.match ? '✓ match' : '✗ diverged', diff.finalUrl.match ? '#1f9d55' : '#d64545')}
          </div>
          ${!diff.finalUrl.match
            ? html`<div class="meta" style="margin-top: 10px; font-size: 11px;">
                <div>baseline ends at <code>${diff.finalUrl.baseline}</code></div>
                <div>current ends at <code>${diff.finalUrl.current}</code></div>
              </div>`
            : ''}
        </div>
      </div>

      ${visual ? renderVisualDiff(visual, baselineSessionId, currentSessionId) : ''}

      <div class="section">
        <h2>Action sequence</h2>
        <div class="card">
          ${diff.actions.ops.length === 0
            ? html`<div class="muted">Neither session has user actions.</div>`
            : html`<div class="action-diff">
                ${diff.actions.ops.map((op) => renderActionOp(op))}
              </div>`}
        </div>
      </div>

      <div class="section">
        <h2>Network responses</h2>
        ${renderNetworkDiff(diff.network)}
      </div>

      ${diff.console.sampleNew.length > 0
        ? html`
            <div class="section">
              <h2>New console errors</h2>
              <div class="card">
                <ul style="margin: 0; padding-left: 18px; font-size: 12px;">
                  ${diff.console.sampleNew.map((m) => html`<li><code>${truncate(m, 200)}</code></li>`)}
                </ul>
              </div>
            </div>
          `
        : ''}

      ${diff.exceptions.sampleNew.length > 0
        ? html`
            <div class="section">
              <h2>New exceptions</h2>
              <div class="card">
                <ul style="margin: 0; padding-left: 18px; font-size: 12px;">
                  ${diff.exceptions.sampleNew.map((m) => html`<li><code>${truncate(m, 200)}</code></li>`)}
                </ul>
              </div>
            </div>
          `
        : ''}

      <style>${DIFF_CSS}</style>
    `,
  })
}

function digestCard(label: string, d: SessionDiff['baseline']): Renderable {
  return html`<div class="card">
    <div class="meta" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
    <div style="margin-top: 4px;">
      <a href="/sessions/${d.id}"><code>${d.id.slice(0, 12)}</code></a>
    </div>
    <div class="meta" style="margin-top: 2px;">
      uploaded ${new Date(d.uploadedAt).toLocaleString()} ·
      duration ${formatDuration(d.durationMs)}
    </div>
  </div>`
}

function kpiTile(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; min-width: 0;">
    <div style="font-size: 16px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px;">${label}</div>
  </div>`
}

function renderActionOp(op: ActionOp): Renderable {
  const sign = op.kind === 'add' ? '+' : op.kind === 'remove' ? '−' : ' '
  const bg = op.kind === 'add'
    ? 'background: rgba(31,157,85,0.08);'
    : op.kind === 'remove'
      ? 'background: rgba(214,69,69,0.08);'
      : ''
  const color = op.kind === 'add' ? '#1f9d55' : op.kind === 'remove' ? '#d64545' : 'var(--muted)'
  const a = op.kind === 'remove' ? op.baseline : op.current
  return html`<div class="diff-row" style="${bg}">
    <span class="diff-sign" style="color: ${color};">${sign}</span>
    <code class="diff-type">${a.type}</code>
    <code class="diff-sel">${truncate(a.selector.primary, 80)}</code>
    ${op.kind === 'keep' && diffPrimaryChanged(op.baseline, op.current)
      ? html`<span class="meta" style="font-size: 10px;">· selector text drifted</span>`
      : ''}
  </div>`
}

function diffPrimaryChanged(a: { selector: { primary: string } }, b: { selector: { primary: string } }): boolean {
  return a.selector.primary !== b.selector.primary
}

function renderNetworkDiff(n: NetworkDiff): Renderable {
  const hasAny =
    n.onlyInCurrent.length > 0 ||
    n.onlyInBaseline.length > 0 ||
    n.statusChanged.length > 0
  if (!hasAny) {
    return html`<div class="card"><div class="muted">No differences in significant responses (${n.common.length} shared).</div></div>`
  }
  return html`
    <div class="card">
      ${n.statusChanged.length > 0
        ? html`<div style="margin-bottom: 12px;">
            <strong style="font-size: 12px;">Status changed (${n.statusChanged.length})</strong>
            <ul style="margin: 4px 0 0 0; padding-left: 18px; font-size: 12px;">
              ${n.statusChanged.map(
                (s) => html`<li>
                  <code>${s.method ?? 'GET'}</code>
                  <code>${truncate(s.url, 80)}</code>
                  · <span style="color: var(--muted);">${s.baselineStatus}</span>
                  → <span style="color: ${s.currentStatus >= 500 ? '#d64545' : s.currentStatus >= 400 ? '#b88300' : '#1f9d55'};">${s.currentStatus}</span>
                </li>`,
              )}
            </ul>
          </div>`
        : ''}
      ${n.onlyInCurrent.length > 0
        ? html`<div style="margin-bottom: 12px;">
            <strong style="font-size: 12px; color: #1f9d55;">New in current (${n.onlyInCurrent.length})</strong>
            <ul style="margin: 4px 0 0 0; padding-left: 18px; font-size: 12px;">
              ${n.onlyInCurrent.map(
                (r) => html`<li><code>${r.status}</code> <code>${truncate(r.url, 80)}</code></li>`,
              )}
            </ul>
          </div>`
        : ''}
      ${n.onlyInBaseline.length > 0
        ? html`<div>
            <strong style="font-size: 12px; color: #d64545;">Missing in current (${n.onlyInBaseline.length})</strong>
            <ul style="margin: 4px 0 0 0; padding-left: 18px; font-size: 12px;">
              ${n.onlyInBaseline.map(
                (r) => html`<li><code>${r.status}</code> <code>${truncate(r.url, 80)}</code></li>`,
              )}
            </ul>
          </div>`
        : ''}
    </div>
  `
}

function renderVisualDiff(
  visual: CrossSessionVisualDiff,
  baselineSessionId: string,
  currentSessionId: string,
): Renderable {
  if (visual.pairs.length === 0 && visual.skipped.length === 0) {
    return html`<div class="section">
      <h2>Visual diff</h2>
      <div class="card"><div class="muted">No captured screenshots on one or both sessions — re-record to enable.</div></div>
    </div>`
  }
  const pct = (visual.totals.ratio * 100).toFixed(2)
  const drift = visual.totals.ratio < 0.005 ? 'minimal drift'
    : visual.totals.ratio < 0.03 ? 'visible differences'
    : 'major drift'
  const color = visual.totals.ratio < 0.005 ? '#1f9d55'
    : visual.totals.ratio < 0.03 ? '#b88300'
    : '#d64545'
  return html`<div class="section">
    <h2>Visual diff</h2>
    <div class="card">
      <div class="meta" style="margin-bottom: 10px;">
        <span class="badge" style="color:${color}; border-color:${color};">${pct}% changed</span>
        · ${drift}
        · ${visual.totals.diffPixels.toLocaleString()} / ${visual.totals.totalPixels.toLocaleString()} pixels across ${visual.pairs.length} matched pair${visual.pairs.length === 1 ? '' : 's'}
        ${visual.skipped.length > 0 ? html` · ${visual.skipped.length} skipped` : ''}
      </div>
      <div style="display:flex; flex-direction:column; gap:14px;">
        ${visual.pairs.map((p, i) => renderVisualPair(p, i, baselineSessionId, currentSessionId))}
      </div>
      ${visual.skipped.length > 0
        ? html`<div class="meta" style="margin-top: 12px; font-size: 11px;">
            Skipped pairs: ${visual.skipped.map((s) => `${s.reason}`).join(' · ')}
          </div>`
        : ''}
    </div>
  </div>`
}

function renderVisualPair(
  pair: CrossSessionVisualDiffPair,
  index: number,
  baselineSessionId: string,
  currentSessionId: string,
): Renderable {
  const pct = (pair.diffRatio * 100).toFixed(2)
  const color = pair.diffRatio < 0.005 ? '#1f9d55'
    : pair.diffRatio < 0.03 ? '#b88300'
    : '#d64545'
  const baseSrc = `/api/sessions/${baselineSessionId}/screenshots/${pair.baselineRef}`
  const curSrc = `/api/sessions/${currentSessionId}/screenshots/${pair.currentRef}`
  const diffSrc = `/api/sessions/${currentSessionId}/screenshots/${pair.diffRef}`
  return html`<div style="border:1px solid var(--border); border-radius:8px; padding:10px;">
    <div class="meta" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
      <strong style="color:var(--fg);">Pair ${index + 1}</strong>
      <span class="badge" style="color:${color}; border-color:${color};">${pct}%</span>
      · ${pair.width}×${pair.height}
      · matched within ${pair.matchTimeDeltaMs}ms
      ${pair.baselineUrl ? html` · <code style="font-size: 11px;">${truncate(pair.baselineUrl, 60)}</code>` : ''}
    </div>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px;">
      ${visualCell('Baseline (A)', baseSrc)}
      ${visualCell('Current (B)', curSrc)}
      ${visualCell('Diff', diffSrc, 'background:#000;')}
    </div>
  </div>`
}

function visualCell(label: string, src: string, extraStyle = ''): Renderable {
  return html`<div>
    <a href="${src}" target="_blank" style="display:block;">
      <img src="${src}" alt="${label}" loading="lazy"
           style="width:100%; height:auto; border-radius:6px; border:1px solid var(--border); ${extraStyle}" />
    </a>
    <div class="meta" style="font-size:10px; margin-top:4px; text-align:center;">${label}</div>
  </div>`
}

const DIFF_CSS = `
.action-diff { display: flex; flex-direction: column; gap: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.diff-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-radius: 4px; }
.diff-sign { width: 12px; text-align: center; font-weight: 700; }
.diff-type { color: var(--accent); min-width: 50px; }
.diff-sel { color: var(--fg); flex: 1; word-break: break-all; }
`

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
