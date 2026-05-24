import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { PageHeatmap } from '../project-heatmap'
import { renderHeatmapSvg } from '../project-heatmap'

export function ProjectHeatmapPage({
  email,
  host,
  pages,
}: {
  email: string
  host: string
  pages: PageHeatmap[]
}): Renderable {
  const totalClicks = pages.reduce((n, p) => n + p.clicks.length, 0)

  return Layout({
    title: `${host} · click heatmap`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Click heatmap</h2>
      <p class="muted">
        Click positions from every captured session, overlaid on a representative screenshot per page.
        Coordinates are normalized to viewport size so heatmaps work across captures with different viewport widths.
      </p>

      ${pages.length === 0
        ? html`<div class="empty">
            <p>No click positions captured yet.</p>
            <p style="margin-top: 12px; font-size: 12px;">
              Click position capture was added recently — existing sessions don't have it.
              Reload the Unwrap extension and record one new session, then come back.
            </p>
          </div>`
        : html`
          <div class="card" style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; font-size: 12px;">
            <div><strong>${pages.length}</strong> page${pages.length === 1 ? '' : 's'} with clicks</div>
            <div><strong>${totalClicks}</strong> total clicks</div>
            <div><strong>${pages.filter((p) => p.screenshot).length}</strong> with screenshot background</div>
          </div>

          ${pages.map((p) => html`
            <div class="section">
              <h2 style="text-transform: none; letter-spacing: 0; font-size: 14px; color: var(--fg); font-weight: 600;">
                <code>${p.normalizedPath}</code>
                <span class="muted" style="font-size: 11px; margin-left: 8px;">
                  ${p.clicks.length} click${p.clicks.length === 1 ? '' : 's'} ·
                  ${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'}
                </span>
              </h2>
              <div class="card" style="padding: 6px; background: var(--bg);">
                ${raw(renderHeatmapSvg(p, p.screenshot ? `/api/sessions/${p.screenshot.sessionId}/screenshots/${p.screenshot.storedRef}` : undefined))}
              </div>
            </div>
          `)}
        `}
    `,
  })
}
