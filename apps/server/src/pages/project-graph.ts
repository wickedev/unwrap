import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ProjectGraph } from '../project-graph'
import { renderProjectGraphSvg } from '../project-graph'

export function ProjectGraphPage({
  email,
  host,
  graph,
}: {
  email: string
  host: string
  graph: ProjectGraph
}): Renderable {
  const { svg, height } = renderProjectGraphSvg(graph)
  return Layout({
    title: `${host} · dependency graph`,
    email,
    body: html`
      <p><a href="/projects/${encodeURIComponent(host)}">← back to ${host}</a></p>
      <h2 style="margin-top: 4px;">Page → API dependency graph</h2>
      <p class="muted">
        Each line connects a page (left) to an API endpoint or GraphQL op (right) that was called while
        the user was on that page. Line thickness scales with total call count across every captured session.
        Hover any node or edge for details.
      </p>

      <div class="card" style="display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; font-size: 12px;">
        <div><strong>${graph.pageCount}</strong> pages</div>
        <div><strong>${graph.endpointCount}</strong> endpoints</div>
        <div><strong>${graph.edgeCount}</strong> page→endpoint links</div>
        <div style="margin-left: auto; display: flex; gap: 12px; align-items: center;">
          <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #2f6feb;"></span> GET / page</span>
          <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #1f9d55;"></span> POST</span>
          <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #b88300;"></span> PUT/PATCH</span>
          <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #d64545;"></span> DELETE</span>
          <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #7c4ac2;"></span> GraphQL</span>
        </div>
      </div>

      ${graph.edgeCount === 0
        ? html`<div class="empty">
            No page→endpoint links to draw yet. Likely cause: the captures were made before the
            extension started collecting API calls. Reload the extension and record one more session.
          </div>`
        : html`<div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; padding: 8px; background: var(--bg);">
            <div style="min-height: ${height}px;">${raw(svg)}</div>
          </div>`}
    `,
  })
}
