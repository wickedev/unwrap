import type { RouteEntry } from './project-aggregate'

export interface RouteTreeNode {
  // Segment shown in the tree, e.g. "t" or "{id}" or "settings".
  segment: string
  // Full path from the host root down to this node, e.g. "/t/{id}/settings".
  fullPath: string
  // Children keyed by segment.
  children: Map<string, RouteTreeNode>
  // The RouteEntry matching this exact path, if a navigation hit it directly.
  // Intermediate nodes (path segments with no exact visit) have leaf=undefined.
  leaf?: RouteEntry
  // Cached subtree weight = leaf visits + every descendant's leaf visits.
  totalVisits: number
}

export interface RouteForest {
  // Trees grouped by host. Most-visited host first.
  hosts: { host: string; root: RouteTreeNode; totalVisits: number; routeCount: number }[]
}

// Builds a per-host nested tree out of the flat RouteEntry list. Splits
// each URL's pathname into segments and inserts. Multiple URLs that
// share a prefix share branches. Intermediate nodes that no nav hit
// directly still appear (for structure), with leaf=undefined.
export function buildRouteForest(routes: RouteEntry[]): RouteForest {
  const byHost = new Map<string, RouteTreeNode>()

  for (const r of routes) {
    let host = '(no host)'
    let pathname = '/'
    try {
      const u = new URL(r.url)
      if (u.host) {
        host = u.host
        // Decode so templated segments captured as {id} survive new URL()'s
        // automatic percent-encoding of braces. Safe because the input comes
        // from our own normalizePath which only produces literals or
        // {id}/{uuid}/{hash} placeholders.
        pathname = decodeURIComponent(u.pathname)
      } else {
        // Hostless scheme like about:blank, data:, chrome:. Keep the original
        // URL as a single leaf under (no host) so the user recognizes it.
        pathname = '/' + r.url
      }
    } catch {
      pathname = '/' + r.url
    }

    let root = byHost.get(host)
    if (!root) {
      root = { segment: host, fullPath: '/', children: new Map(), totalVisits: 0 }
      byHost.set(host, root)
    }

    const segs = pathname.split('/').filter(Boolean)
    if (segs.length === 0) {
      // The bare host root, e.g. https://example.com/
      root.leaf = r
    } else {
      let cur = root
      let acc = ''
      for (const seg of segs) {
        acc = `${acc}/${seg}`
        let child = cur.children.get(seg)
        if (!child) {
          child = { segment: seg, fullPath: acc, children: new Map(), totalVisits: 0 }
          cur.children.set(seg, child)
        }
        cur = child
      }
      cur.leaf = r
    }
  }

  // Compute totalVisits bottom-up so we can sort children by it.
  for (const root of byHost.values()) computeTotals(root)

  const hosts = [...byHost.entries()]
    .map(([host, root]) => ({
      host,
      root,
      totalVisits: root.totalVisits,
      routeCount: countLeaves(root),
    }))
    .sort((a, b) => b.totalVisits - a.totalVisits || a.host.localeCompare(b.host))

  return { hosts }
}

function computeTotals(node: RouteTreeNode): number {
  let total = node.leaf?.visitCount ?? 0
  for (const child of node.children.values()) total += computeTotals(child)
  node.totalVisits = total
  return total
}

function countLeaves(node: RouteTreeNode): number {
  let n = node.leaf ? 1 : 0
  for (const child of node.children.values()) n += countLeaves(child)
  return n
}

// Renders the forest as nested HTML — using <details>/<summary> so users
// can collapse heavy subtrees. Hosts at top level expanded; deeper
// branches collapsed by default once the tree gets large.
export function renderRouteForestHtml(forest: RouteForest): string {
  if (forest.hosts.length === 0) return '<div class="muted">No routes captured.</div>'
  const parts: string[] = []
  parts.push('<div class="route-tree">')
  for (const h of forest.hosts) {
    parts.push(`<div class="route-host">`)
    parts.push(`<div class="route-host-head"><strong>${esc(h.host)}</strong> <span class="meta">${h.routeCount} route${h.routeCount === 1 ? '' : 's'} · ${h.totalVisits} visit${h.totalVisits === 1 ? '' : 's'}</span></div>`)
    parts.push('<ul class="route-tree-list">')
    if (h.root.leaf) parts.push(renderLeaf(h.root.leaf, '/'))
    for (const child of sortedChildren(h.root)) {
      parts.push(renderNode(child, 0))
    }
    parts.push('</ul>')
    parts.push('</div>')
  }
  parts.push('</div>')
  return parts.join('')
}

function renderNode(node: RouteTreeNode, depth: number): string {
  const hasChildren = node.children.size > 0
  const visits = node.leaf?.visitCount ?? 0
  const sessions = node.leaf?.sessionCount ?? 0
  // Auto-collapse deep, busy subtrees so the tree stays scannable.
  const open = depth < 1 || node.totalVisits >= 3
  const segLabel = `<code class="seg">${esc(node.segment)}</code>`
  const meta = node.leaf
    ? `<span class="meta">${visits} visit${visits === 1 ? '' : 's'} · ${sessions} session${sessions === 1 ? '' : 's'}</span>`
    : `<span class="meta">${node.totalVisits} visit${node.totalVisits === 1 ? '' : 's'} below</span>`
  const labelLine = node.leaf
    ? `${segLabel} ${meta}`
    : `${segLabel} <span class="muted intermediate">(no direct visit)</span> ${meta}`

  if (!hasChildren) {
    return `<li>${labelLine}</li>`
  }

  return `<li>
    <details ${open ? 'open' : ''}>
      <summary>${labelLine}</summary>
      <ul>
        ${[...sortedChildren(node)].map((c) => renderNode(c, depth + 1)).join('\n')}
      </ul>
    </details>
  </li>`
}

function renderLeaf(r: { visitCount: number; sessionCount: number }, segment: string): string {
  return `<li><code class="seg">${esc(segment)}</code> <span class="meta">${r.visitCount} visit${r.visitCount === 1 ? '' : 's'} · ${r.sessionCount} session${r.sessionCount === 1 ? '' : 's'}</span></li>`
}

function sortedChildren(node: RouteTreeNode): RouteTreeNode[] {
  return [...node.children.values()].sort(
    (a, b) => b.totalVisits - a.totalVisits || a.segment.localeCompare(b.segment),
  )
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export const ROUTE_TREE_CSS = `
.route-tree { font-size: 13px; }
.route-host { margin-bottom: 18px; }
.route-host-head { margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.route-host-head .meta { margin-left: 6px; font-size: 11px; }
.route-tree-list, .route-tree ul { list-style: none; padding-left: 18px; margin: 2px 0; border-left: 1px dashed var(--border); }
.route-tree > .route-host > .route-tree-list { padding-left: 6px; border-left: 0; }
.route-tree li { padding: 2px 0; }
.route-tree summary { cursor: pointer; padding: 1px 0; outline: none; }
.route-tree summary::marker { color: var(--muted); }
.route-tree code.seg { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: rgba(127,127,127,0.08); padding: 1px 6px; border-radius: 4px; }
.route-tree .meta { font-size: 11px; color: var(--muted); margin-left: 6px; }
.route-tree .intermediate { font-size: 11px; }
`
