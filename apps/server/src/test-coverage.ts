import type { StoredSession } from '@unwrap/protocol'
import { buildProjectGraph, type ProjectGraph } from './project-graph'

export interface TestCoverage {
  // Per-route coverage. One entry per unique normalized path observed in
  // the project's navigations. coveringSpecs lists sessions whose
  // generated spec navigates to a URL that normalizes to the same path.
  routes: RouteCoverage[]
  // Endpoints "transitively" covered by a spec — if the spec visits a
  // page that historically fired this endpoint, we consider it covered.
  endpoints: EndpointCoverage[]
  // Every session that has a generated spec, summarized.
  specs: SpecMeta[]
  // Headline numbers for the KPI strip.
  routesCoveredCount: number
  routesTotalCount: number
  endpointsCoveredCount: number
  endpointsTotalCount: number
}

export interface RouteCoverage {
  normalizedPath: string
  // First raw URL we saw for display.
  exampleUrl: string
  visitCount: number
  sessionCount: number
  // Session ids of every spec that visits this route.
  coveringSpecs: string[]
}

export interface EndpointCoverage {
  method: string
  normalizedPath: string
  callCount: number
  // Transitively covering specs — derived from the page→endpoint mapping.
  coveringSpecs: string[]
}

export interface SpecMeta {
  sessionId: string
  uploadedAt: number
  // Normalized path templates visited by this spec.
  visitedRoutes: string[]
  startUrl: string
}

// Walks the project's sessions, finds every generated Playwright spec,
// parses each spec's page.goto() calls, normalizes the visited URLs to
// path templates, and joins against the project's known routes and
// endpoints to produce a coverage report.
//
// The endpoint coverage is transitive: a spec covers endpoint E if it
// visits a page that historically fired E (derived from the same
// page→endpoint mapping used by the dependency graph).
export function analyzeTestCoverage(sessions: StoredSession[]): TestCoverage {
  // 1. Collect specs.
  const specs: SpecMeta[] = []
  for (const s of sessions) {
    const spec = s.generated?.spec
    if (!spec) continue
    const visitedRoutes = extractVisitedRoutes(spec)
    specs.push({
      sessionId: s.id,
      uploadedAt: s.uploadedAt,
      visitedRoutes,
      startUrl: s.summary.meta.url,
    })
  }

  // 2. Build the project-wide route inventory (one entry per normalized
  //    path, with aggregated visit and session counts).
  const routeMap = new Map<string, RouteCoverage>()
  for (const s of sessions) {
    const sessionVisitedRoutes = new Set<string>()
    for (const nav of s.summary.navigations ?? []) {
      const np = normalizeUrl(nav.url)
      if (!np) continue
      let entry = routeMap.get(np)
      if (!entry) {
        entry = {
          normalizedPath: np,
          exampleUrl: nav.url,
          visitCount: 0,
          sessionCount: 0,
          coveringSpecs: [],
        }
        routeMap.set(np, entry)
      }
      entry.visitCount++
      sessionVisitedRoutes.add(np)
    }
    for (const np of sessionVisitedRoutes) {
      routeMap.get(np)!.sessionCount++
    }
  }

  // 3. Mark each route as covered by every spec whose visited set includes it.
  for (const spec of specs) {
    const visited = new Set(spec.visitedRoutes)
    for (const [np, entry] of routeMap) {
      if (visited.has(np)) entry.coveringSpecs.push(spec.sessionId)
    }
  }

  // 4. Endpoint coverage via the page→endpoint mapping.
  const graph = buildProjectGraph(sessions)
  const endpointToPages = buildEndpointToPagesMap(graph)
  const callCountByEndpoint = new Map<string, { method: string; normalizedPath: string; callCount: number }>()
  for (const node of graph.nodes) {
    if (node.kind === 'page') continue
    const key = endpointDisplayKey(node)
    callCountByEndpoint.set(key, {
      method: node.method ?? '',
      normalizedPath: node.label,
      callCount: node.weight,
    })
  }

  const endpoints: EndpointCoverage[] = []
  for (const [epKey, meta] of callCountByEndpoint) {
    // Pages that fire this endpoint (normalized path strings)
    const pages = endpointToPages.get(epKey) ?? new Set<string>()
    // A spec covers this endpoint if it visits any of those pages.
    const covering: string[] = []
    for (const spec of specs) {
      const visited = new Set(spec.visitedRoutes)
      const hit = [...pages].some((p) => visited.has(p))
      if (hit) covering.push(spec.sessionId)
    }
    endpoints.push({
      method: meta.method,
      normalizedPath: meta.normalizedPath,
      callCount: meta.callCount,
      coveringSpecs: covering,
    })
  }
  endpoints.sort((a, b) => b.callCount - a.callCount)

  const routes = [...routeMap.values()].sort((a, b) => b.visitCount - a.visitCount)

  return {
    routes,
    endpoints,
    specs,
    routesCoveredCount: routes.filter((r) => r.coveringSpecs.length > 0).length,
    routesTotalCount: routes.length,
    endpointsCoveredCount: endpoints.filter((e) => e.coveringSpecs.length > 0).length,
    endpointsTotalCount: endpoints.length,
  }
}

// Extract every URL passed to page.goto() (and a couple of related Playwright
// calls) from the spec text, normalize each into a path template.
function extractVisitedRoutes(spec: string): string[] {
  const urls = new Set<string>()
  // page.goto('https://…') — single or double quotes, plus backtick template literals.
  const re = /page\.(?:goto|waitForURL|waitForLoadState)\s*\(\s*(['"`])([^'"`]+)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(spec)) !== null) {
    urls.add(m[2]!)
  }
  // Also pull URL strings from any storageState-style fields if they appear
  // in the captured navs comment — Gemini sometimes inlines them.
  const navUrlComment = /\/\/\s*(?:navigates to|goto)\s+(https?:\/\/[^\s]+)/g
  while ((m = navUrlComment.exec(spec)) !== null) {
    urls.add(m[1]!)
  }
  const out: string[] = []
  for (const url of urls) {
    const np = normalizeUrl(url)
    if (np) out.push(np)
  }
  return [...new Set(out)]
}

function buildEndpointToPagesMap(graph: ProjectGraph): Map<string, Set<string>> {
  // Map endpoint id → set of normalized page paths that fire it.
  const out = new Map<string, Set<string>>()
  const pageIdToPath = new Map<string, string>()
  for (const n of graph.nodes) {
    if (n.kind === 'page') pageIdToPath.set(n.id, n.label)
  }
  for (const edge of graph.edges) {
    const epKey = `${edge.target}` // endpoint node id
    const pageLabel = pageIdToPath.get(edge.source)
    if (!pageLabel) continue
    const set = out.get(epKey) ?? new Set<string>()
    set.add(pageLabel)
    out.set(epKey, set)
  }
  return out
}

function endpointDisplayKey(node: { id: string; kind: string; method?: string; label: string }): string {
  return node.id
}

// Convert a raw URL (or string that might be one) into a normalized path
// template — same logic as the rest of the server. Returns null when the
// input doesn't parse.
function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return normalizePath(u.pathname)
  } catch {
    return null
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
