import type { ApiCall, StoredSession } from '@unwrap/protocol'
import { extractGraphqlOperations, type GraphqlOperation } from './graphql-extract'

export interface ProjectDigest {
  host: string
  sessionCount: number
  firstCapturedAt: number
  lastCapturedAt: number
  // Every URL ever navigated to, deduped by full URL string.
  routes: RouteEntry[]
  // Every API endpoint signature ever hit, with samples merged across
  // sessions so the downstream type inference can use the union.
  endpoints: EndpointEntry[]
  // GraphQL operations merged across every session — same dedupe-by-hash
  // logic as the single-session extractor, but the variable-type widening
  // and __typename collection happen over the full union of calls.
  graphqlOps: GraphqlOperation[]
  // Static asset URLs observed, plus how many sessions captured each.
  staticAssets: AssetEntry[]
  // Lightweight list of contributing sessions for navigation back.
  sessions: { id: string; startedAt: string; uploadedAt: number; durationMs: number }[]
}

export interface RouteEntry {
  url: string
  normalizedPath: string
  visitCount: number
  // Count of distinct sessions that included this URL.
  sessionCount: number
  firstSeenSessionId: string
  lastSeenSessionId: string
  // For convenience when rendering — when the route was first/last seen.
  firstSeenTs: number
  lastSeenTs: number
}

export interface EndpointEntry {
  key: string
  method: string
  hostname: string
  normalizedPath: string
  callCount: number
  sessionCount: number
  // status code → count, summed across every captured call.
  statuses: Record<number, number>
  // Up to ~25 sample bodies preserved so api-inventory's existing
  // inferType() can run over a much larger sample than a single session.
  responseSamples: string[]
  requestSamples: string[]
  // One representative call kept around for renderGroup's cURL block etc.
  sampleCall: ApiCall
  graphql?: { operationName?: string; operationType?: string }
  responseMimeType: string
}

export interface AssetEntry {
  url: string
  mimeType: string
  // Max captured size across sessions — useful as "biggest version we saw".
  sizeMax: number
  sessionCount: number
  hasBody: boolean
}

const MAX_SAMPLES_PER_ENDPOINT = 25

export function aggregateProject(host: string, sessions: StoredSession[]): ProjectDigest {
  const sorted = [...sessions].sort((a, b) => a.uploadedAt - b.uploadedAt)

  const routes = new Map<string, MutableRoute>()
  const endpoints = new Map<string, MutableEndpoint>()
  const assets = new Map<string, MutableAsset>()
  let earliestUploadedAt = Number.POSITIVE_INFINITY
  let latestUploadedAt = 0

  for (const s of sorted) {
    earliestUploadedAt = Math.min(earliestUploadedAt, s.uploadedAt)
    latestUploadedAt = Math.max(latestUploadedAt, s.uploadedAt)

    // Routes from navigations
    const navs = s.summary.navigations ?? []
    const seenRoutesThisSession = new Set<string>()
    for (const nav of navs) {
      let normalizedPath = nav.url
      try {
        const u = new URL(nav.url)
        normalizedPath = normalizePath(u.pathname)
      } catch {
        // keep raw
      }
      const r = routes.get(nav.url)
      if (!r) {
        routes.set(nav.url, {
          url: nav.url,
          normalizedPath,
          visitCount: 1,
          sessionCount: 1,
          firstSeenSessionId: s.id,
          lastSeenSessionId: s.id,
          firstSeenTs: nav.ts,
          lastSeenTs: nav.ts,
        })
        seenRoutesThisSession.add(nav.url)
      } else {
        r.visitCount++
        r.lastSeenSessionId = s.id
        r.lastSeenTs = nav.ts
        if (!seenRoutesThisSession.has(nav.url)) {
          r.sessionCount++
          seenRoutesThisSession.add(nav.url)
        }
      }
    }

    // Endpoints from apiCalls — merge sample bodies across sessions.
    const calls = s.summary.apiCalls ?? []
    const seenEndpointsThisSession = new Set<string>()
    for (const c of calls) {
      let hostname = ''
      let normalizedPath = c.url
      try {
        const u = new URL(c.url)
        hostname = u.host
        normalizedPath = normalizePath(u.pathname)
      } catch {
        // ignore
      }
      const gqlKey = c.graphql?.operationName ?? c.graphql?.queryHash
      const key = `${c.method.toUpperCase()} ${hostname}${normalizedPath}${gqlKey ? `#${gqlKey}` : ''}`
      let e = endpoints.get(key)
      if (!e) {
        e = {
          key,
          method: c.method.toUpperCase(),
          hostname,
          normalizedPath,
          callCount: 0,
          sessionCount: 0,
          statuses: {},
          responseSamples: [],
          requestSamples: [],
          sampleCall: c,
          responseMimeType: c.responseMimeType ?? '',
          ...(c.graphql
            ? { graphql: { operationName: c.graphql.operationName, operationType: c.graphql.operationType } }
            : {}),
        }
        endpoints.set(key, e)
      }
      e.callCount++
      if (!seenEndpointsThisSession.has(key)) {
        e.sessionCount++
        seenEndpointsThisSession.add(key)
      }
      e.statuses[c.status] = (e.statuses[c.status] ?? 0) + 1
      if (c.responseBody && e.responseSamples.length < MAX_SAMPLES_PER_ENDPOINT) {
        e.responseSamples.push(c.responseBody)
      }
      if (c.requestBody && e.requestSamples.length < MAX_SAMPLES_PER_ENDPOINT) {
        e.requestSamples.push(c.requestBody)
      }
    }

    // Static assets — record presence, not bodies.
    for (const a of s.summary.staticAssets ?? []) {
      let entry = assets.get(a.url)
      if (!entry) {
        entry = {
          url: a.url,
          mimeType: a.mimeType,
          sizeMax: a.size,
          sessionCount: 1,
          hasBody: !!a.body,
        }
        assets.set(a.url, entry)
      } else {
        entry.sessionCount++
        entry.sizeMax = Math.max(entry.sizeMax, a.size)
        if (a.body) entry.hasBody = true
      }
    }
  }

  // GraphQL aggregation: feed a synthetic session containing every call to
  // the existing extractor so widening + typename collection runs over the
  // full union. The extractor only reads `apiCalls` + meta — no other state.
  const mergedSession: StoredSession = {
    ...(sorted[0] ?? ({} as StoredSession)),
    id: `project-${host}`,
    summary: {
      ...(sorted[0]?.summary ?? ({} as StoredSession['summary'])),
      apiCalls: sorted.flatMap((s) => s.summary.apiCalls ?? []),
      meta: {
        ...(sorted[0]?.summary.meta ?? ({} as StoredSession['summary']['meta'])),
        host,
      },
    },
  }
  const gqlArtifact = extractGraphqlOperations(mergedSession)
  const graphqlOps = gqlArtifact?.operations ?? []

  const routeList = [...routes.values()].sort((a, b) => a.firstSeenTs - b.firstSeenTs)
  const endpointList = [...endpoints.values()].sort((a, b) => {
    if (!!a.graphql !== !!b.graphql) return a.graphql ? -1 : 1
    return b.callCount - a.callCount
  })
  const assetList = [...assets.values()].sort((a, b) => a.url.localeCompare(b.url))

  return {
    host,
    sessionCount: sorted.length,
    firstCapturedAt: earliestUploadedAt === Number.POSITIVE_INFINITY ? 0 : earliestUploadedAt,
    lastCapturedAt: latestUploadedAt,
    routes: routeList,
    endpoints: endpointList,
    graphqlOps,
    staticAssets: assetList,
    sessions: sorted.map((s) => ({
      id: s.id,
      startedAt: s.summary.meta.startedAt,
      uploadedAt: s.uploadedAt,
      durationMs: s.summary.meta.durationMs,
    })),
  }
}

interface MutableRoute extends RouteEntry {}
interface MutableEndpoint extends EndpointEntry {}
interface MutableAsset extends AssetEntry {}

function normalizePath(p: string): string {
  return (
    '/' +
    p
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        if (/^\d+$/.test(seg)) return '{id}'
        if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}'
        if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}'
        return seg
      })
      .join('/')
  )
}

// Group session list items into per-host projects, keeping the most-recent
// upload first. Used by the home page to render the Projects strip without
// loading every session body.
export interface ProjectListItem {
  host: string
  sessionCount: number
  latestUploadedAt: number
}

export function groupSessionsByHost(
  items: { host: string; uploadedAt: number }[],
): ProjectListItem[] {
  const map = new Map<string, ProjectListItem>()
  for (const it of items) {
    const host = it.host || '(no host)'
    const existing = map.get(host)
    if (!existing) {
      map.set(host, { host, sessionCount: 1, latestUploadedAt: it.uploadedAt })
    } else {
      existing.sessionCount++
      existing.latestUploadedAt = Math.max(existing.latestUploadedAt, it.uploadedAt)
    }
  }
  return [...map.values()].sort((a, b) => b.latestUploadedAt - a.latestUploadedAt)
}
