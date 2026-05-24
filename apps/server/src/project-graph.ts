import type { StoredSession } from '@unwrap/protocol'

export interface GraphNode {
  id: string
  // 'page' = a navigation URL, 'rest' = HTTP endpoint, 'gql' = GraphQL op
  kind: 'page' | 'rest' | 'gql'
  // What to show inside the node (path or operation name).
  label: string
  // Method (REST) / operationType (GraphQL) for color coding.
  method?: string
  // Total weight — page node: number of visits; endpoint node: total calls.
  weight: number
}

export interface GraphEdge {
  source: string // page node id
  target: string // endpoint or gql node id
  weight: number // call count across all sessions for this (page, endpoint) pair
}

export interface ProjectGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  // Convenience totals for headline KPI.
  pageCount: number
  endpointCount: number
  edgeCount: number
}

// Builds a bipartite graph: pages on one side, endpoints + GraphQL ops on
// the other. An edge means "during a navigation to this page, this
// endpoint was called." Edges aggregate across every captured session,
// so weight is the total call count from that page to that endpoint.
//
// We bucket calls by navigation window — every apiCall whose ts falls
// between navigation[i].ts and navigation[i+1].ts is attributed to
// navigation[i]'s URL. Same pairing logic as the sitemap builder.
export function buildProjectGraph(sessions: StoredSession[]): ProjectGraph {
  const pageWeight = new Map<string, number>()
  const endpointWeight = new Map<string, GraphNode>()
  const edgeWeight = new Map<string, GraphEdge>()

  for (const s of sessions) {
    const navs = (s.summary.navigations ?? []).slice().sort((a, b) => a.ts - b.ts)
    const calls = (s.summary.apiCalls ?? []).slice().sort((a, b) => a.ts - b.ts)
    if (navs.length === 0) continue

    for (let i = 0; i < navs.length; i++) {
      const nav = navs[i]!
      const next = navs[i + 1]
      const windowEnd = next ? next.ts : Number.POSITIVE_INFINITY
      const pageId = pageIdFor(nav.url)
      pageWeight.set(pageId, (pageWeight.get(pageId) ?? 0) + 1)

      for (const c of calls) {
        if (c.ts < nav.ts || c.ts >= windowEnd) continue

        const ep = endpointFor(c)
        const epId = ep.id
        const existing = endpointWeight.get(epId)
        if (existing) existing.weight++
        else endpointWeight.set(epId, { ...ep, weight: 1 })

        const edgeKey = `${pageId}|${epId}`
        const e = edgeWeight.get(edgeKey)
        if (e) e.weight++
        else edgeWeight.set(edgeKey, { source: pageId, target: epId, weight: 1 })
      }
    }
  }

  // Build node list. Pages first, then endpoints (REST then GraphQL).
  const nodes: GraphNode[] = []
  for (const [id, weight] of pageWeight) {
    nodes.push({ id, kind: 'page', label: pageLabelFor(id), weight })
  }
  for (const ep of endpointWeight.values()) {
    nodes.push(ep)
  }

  return {
    nodes,
    edges: [...edgeWeight.values()],
    pageCount: pageWeight.size,
    endpointCount: endpointWeight.size,
    edgeCount: edgeWeight.size,
  }
}

function pageIdFor(url: string): string {
  try {
    const u = new URL(url)
    return `page:${u.host}${normalizePath(u.pathname)}`
  } catch {
    return `page:${url}`
  }
}

function pageLabelFor(id: string): string {
  // strip the "page:host" prefix → just the path
  const slash = id.indexOf('/', 'page:'.length)
  if (slash < 0) return id.slice('page:'.length)
  return id.slice(slash)
}

function endpointFor(c: { method: string; url: string; graphql?: { operationName?: string; operationType?: string; queryHash?: string } }): GraphNode {
  let normalizedPath = c.url
  try {
    normalizedPath = normalizePath(new URL(c.url).pathname)
  } catch {
    // keep raw
  }
  if (c.graphql) {
    const name = c.graphql.operationName ?? `op:${c.graphql.queryHash ?? 'anon'}`
    return {
      id: `gql:${name}`,
      kind: 'gql',
      label: name,
      method: c.graphql.operationType ?? 'query',
      weight: 0,
    }
  }
  return {
    id: `rest:${c.method.toUpperCase()} ${normalizedPath}`,
    kind: 'rest',
    label: normalizedPath,
    method: c.method.toUpperCase(),
    weight: 0,
  }
}

function normalizePath(p: string): string {
  return (
    '/' +
    p.split('/').filter(Boolean).map((seg) => {
      if (/^\d+$/.test(seg)) return '{id}'
      if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}'
      if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}'
      return seg
    }).join('/')
  )
}

// Renders the project graph as a standalone SVG element. Bipartite layout:
// pages on the left, endpoints (REST + GraphQL) on the right, edges as
// quadratic Bézier curves with thickness ∝ call count. Server-rendered so
// the page works without client JS. Returns the SVG string and the
// viewport height the caller should reserve.
export function renderProjectGraphSvg(graph: ProjectGraph): { svg: string; height: number } {
  const pages = graph.nodes
    .filter((n) => n.kind === 'page')
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
  const endpoints = graph.nodes
    .filter((n) => n.kind !== 'page')
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'gql' ? -1 : 1
      return b.weight - a.weight || a.label.localeCompare(b.label)
    })

  const rowHeight = 28
  const padding = 16
  const labelLeftW = 380
  const labelRightW = 380
  const middleW = 220
  const totalWidth = labelLeftW + middleW + labelRightW + padding * 2
  const totalHeight = Math.max(pages.length, endpoints.length) * rowHeight + padding * 2

  const pageY = (i: number) => padding + i * rowHeight + rowHeight / 2
  const epY = (i: number) => padding + i * rowHeight + rowHeight / 2

  const pageX = padding + labelLeftW
  const epX = padding + labelLeftW + middleW

  // Map node id → its y position so edges can find both ends.
  const pageYById = new Map<string, number>()
  pages.forEach((p, i) => pageYById.set(p.id, pageY(i)))
  const epYById = new Map<string, number>()
  endpoints.forEach((e, i) => epYById.set(e.id, epY(i)))

  const maxEdgeWeight = Math.max(1, ...graph.edges.map((e) => e.weight))
  const edgeStroke = (w: number) => Math.max(0.8, (w / maxEdgeWeight) * 4)
  const edgeOpacity = (w: number) => 0.25 + (w / maxEdgeWeight) * 0.55

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="100%" preserveAspectRatio="xMidYMin meet" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">`)

  // Edges first (so they render under nodes).
  for (const e of graph.edges) {
    const y1 = pageYById.get(e.source)
    const y2 = epYById.get(e.target)
    if (y1 === undefined || y2 === undefined) continue
    const c1x = pageX + middleW / 3
    const c2x = pageX + (middleW * 2) / 3
    const d = `M ${pageX} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${epX} ${y2}`
    out.push(`<path d="${d}" fill="none" stroke="currentColor" stroke-width="${edgeStroke(e.weight).toFixed(2)}" stroke-opacity="${edgeOpacity(e.weight).toFixed(2)}"><title>${esc(labelById(graph, e.source))}  →  ${esc(labelById(graph, e.target))}  ·  ${e.weight} call${e.weight === 1 ? '' : 's'}</title></path>`)
  }

  // Page nodes (left column)
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!
    const y = pageY(i)
    out.push(`<g><title>${esc(p.label)} · ${p.weight} visit${p.weight === 1 ? '' : 's'}</title>`)
    out.push(`<text x="${pageX - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="currentColor">${esc(truncate(p.label, 56))}</text>`)
    out.push(`<circle cx="${pageX}" cy="${y}" r="4" fill="#2f6feb"/>`)
    out.push(`</g>`)
  }

  // Endpoint nodes (right column)
  for (let i = 0; i < endpoints.length; i++) {
    const e = endpoints[i]!
    const y = epY(i)
    const color = nodeColor(e)
    const methodPill =
      e.kind === 'rest'
        ? `<text x="${epX + 8}" y="${y}" dominant-baseline="middle" font-weight="700" font-size="9" fill="${color}">${esc(e.method ?? '')}</text>`
        : `<text x="${epX + 8}" y="${y}" dominant-baseline="middle" font-weight="700" font-size="9" fill="${color}">${esc((e.method ?? 'query').toUpperCase().slice(0, 4))}</text>`
    const methodW = e.kind === 'rest' ? ((e.method ?? '').length * 6 + 6) : 30
    out.push(`<g><title>${esc(e.label)} · ${e.weight} call${e.weight === 1 ? '' : 's'}</title>`)
    out.push(`<circle cx="${epX}" cy="${y}" r="4" fill="${color}"/>`)
    out.push(methodPill)
    out.push(`<text x="${epX + 8 + methodW}" y="${y}" dominant-baseline="middle" fill="currentColor">${esc(truncate(e.label, 50))}</text>`)
    out.push(`</g>`)
  }

  out.push(`</svg>`)
  return { svg: out.join(''), height: totalHeight }
}

function labelById(g: ProjectGraph, id: string): string {
  const n = g.nodes.find((n) => n.id === id)
  return n ? n.label : id
}

function nodeColor(n: GraphNode): string {
  if (n.kind === 'gql') return '#7c4ac2'
  switch ((n.method ?? '').toUpperCase()) {
    case 'GET': return '#2f6feb'
    case 'POST': return '#1f9d55'
    case 'PUT':
    case 'PATCH': return '#b88300'
    case 'DELETE': return '#d64545'
    default: return '#8c8c8c'
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
