import type { ApiCall, StoredSession } from '@unwrap/protocol'
import type { EndpointEntry, ProjectDigest } from './project-aggregate'
import { inferJsonSchema, type JsonSchema } from './schema-infer'

// Minimal subset of the OpenAPI 3.0 shapes we emit. Hand-typed (rather
// than depending on a full openapi types package) so we stay on Workers.
interface OpenApiSpec {
  openapi: '3.0.3'
  info: { title: string; version: string; description?: string }
  servers: { url: string }[]
  tags?: { name: string; description?: string }[]
  paths: Record<string, PathItem>
  components?: { schemas?: Record<string, JsonSchema> }
}

interface PathItem {
  get?: Operation
  post?: Operation
  put?: Operation
  patch?: Operation
  delete?: Operation
  parameters?: Parameter[]
}

interface Operation {
  operationId: string
  summary?: string
  tags?: string[]
  description?: string
  parameters?: Parameter[]
  requestBody?: RequestBody
  responses: Record<string, ResponseObject>
}

interface Parameter {
  name: string
  in: 'path' | 'query' | 'header'
  required?: boolean
  schema: JsonSchema
  description?: string
  example?: unknown
}

interface RequestBody {
  required?: boolean
  content: Record<string, { schema?: JsonSchema; example?: unknown }>
}

interface ResponseObject {
  description: string
  content?: Record<string, { schema?: JsonSchema; example?: unknown }>
}

export interface OpenApiArtifact {
  filename: string
  body: string
  pathCount: number
  operationCount: number
}

// Convert a project digest (or single session, normalized into the same
// EndpointEntry shape) into an OpenAPI 3.0 spec. REST endpoints become
// path items; GraphQL operations are deliberately excluded — they'd all
// collapse onto `POST /graphql` and OpenAPI is the wrong shape for them.
// GraphQL has its own dedicated `operations.graphql` artifact.
export function buildOpenApiFromProject(digest: ProjectDigest): OpenApiArtifact {
  const restEndpoints = digest.endpoints.filter((e) => !e.graphql)
  const spec = buildSpec({
    title: `${digest.host} API`,
    description: `Inferred by Unwrap from ${digest.sessionCount} captured browser session${digest.sessionCount === 1 ? '' : 's'} of ${digest.host}. Paths, parameters, and response shapes come from the union of every observed call. This is a starting point — fields that didn't appear in any capture are absent; status codes only include captured ones.`,
    host: digest.host,
    endpoints: restEndpoints,
  })
  const body = JSON.stringify(spec, null, 2)
  const safeHost = safe(digest.host)
  return {
    filename: `openapi-${safeHost}.json`,
    body,
    pathCount: Object.keys(spec.paths).length,
    operationCount: countOperations(spec),
  }
}

// Single-session version — synthesizes the same EndpointEntry shape
// from raw ApiCalls so we can reuse one spec builder.
export function buildOpenApiFromSession(session: StoredSession): OpenApiArtifact {
  const endpoints = endpointsFromSession(session)
  const restEndpoints = endpoints.filter((e) => !e.graphql)
  const spec = buildSpec({
    title: `${session.summary.meta.host || 'session'} API`,
    description: `Inferred by Unwrap from a single browser session captured at ${session.summary.meta.startedAt}. For a richer spec across multiple captures, see the project page.`,
    host: session.summary.meta.host || 'localhost',
    endpoints: restEndpoints,
  })
  const body = JSON.stringify(spec, null, 2)
  const safeHost = safe(session.summary.meta.host || 'session')
  return {
    filename: `openapi-${safeHost}-${session.id.slice(0, 8)}.json`,
    body,
    pathCount: Object.keys(spec.paths).length,
    operationCount: countOperations(spec),
  }
}

function buildSpec(opts: { title: string; description: string; host: string; endpoints: EndpointEntry[] }): OpenApiSpec {
  const paths: Record<string, PathItem> = {}
  for (const e of opts.endpoints) {
    const path = paths[e.normalizedPath] ?? {}
    const op = buildOperation(e)
    const method = e.method.toLowerCase() as keyof PathItem
    if (method === 'get' || method === 'post' || method === 'put' || method === 'patch' || method === 'delete') {
      path[method] = op
    }
    paths[e.normalizedPath] = path
  }

  // One tag per distinct first-path-segment so consumers like Postman get a
  // sensible folder structure (`/api/users/{id}` → tag `users`).
  const tags = collectTags(opts.endpoints)

  return {
    openapi: '3.0.3',
    info: {
      title: opts.title,
      version: '0.0.0-unwrap',
      description: opts.description,
    },
    servers: [{ url: `https://${opts.host}` }],
    ...(tags.length > 0 ? { tags } : {}),
    paths,
  }
}

function buildOperation(e: EndpointEntry): Operation {
  const requestSamples = parseAll(e.requestSamples)
  const responseSamples = parseAll(e.responseSamples)
  const requestSchema = inferJsonSchema(requestSamples)
  const responseSchema = inferJsonSchema(responseSamples)

  const pathParams = extractPathParams(e.normalizedPath)
  const tag = primaryTag(e.normalizedPath)

  // Status code → response. We have one shape across all status codes
  // because we don't keep per-status sample arrays — that's OK for a
  // first cut; users can split manually if needed.
  const responses: Record<string, ResponseObject> = {}
  const statusCodes = Object.keys(e.statuses).map(Number).sort()
  for (const code of statusCodes) {
    const isSuccess = code >= 200 && code < 300
    responses[String(code)] = {
      description: `${e.statuses[code]} call${e.statuses[code] === 1 ? '' : 's'} returned ${code}.`,
      ...(isSuccess && responseSchema
        ? {
            content: {
              [e.responseMimeType || 'application/json']: {
                schema: responseSchema,
                ...(responseSamples[0] !== undefined ? { example: responseSamples[0] } : {}),
              },
            },
          }
        : {}),
    }
  }
  if (Object.keys(responses).length === 0) {
    responses['default'] = { description: 'No status codes captured' }
  }

  const operation: Operation = {
    operationId: makeOperationId(e),
    summary: `${e.method} ${e.normalizedPath}`,
    tags: [tag],
    description: `Inferred from ${e.callCount} captured call${e.callCount === 1 ? '' : 's'} across ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}.`,
    ...(pathParams.length > 0 ? { parameters: pathParams } : {}),
    ...(requestSchema && (e.method === 'POST' || e.method === 'PUT' || e.method === 'PATCH')
      ? {
          requestBody: {
            content: {
              'application/json': {
                schema: requestSchema,
                ...(requestSamples[0] !== undefined ? { example: requestSamples[0] } : {}),
              },
            },
          },
        }
      : {}),
    responses,
  }
  return operation
}

function extractPathParams(normalizedPath: string): Parameter[] {
  const params: Parameter[] = []
  const seen = new Set<string>()
  // Match {id}, {uuid}, {hash} placeholders.
  const re = /\{([^}]+)\}/g
  let m
  while ((m = re.exec(normalizedPath)) !== null) {
    const raw = m[1]!
    // Disambiguate repeats: `/orgs/{id}/users/{id}` → second becomes `id2`.
    let name = raw
    let suffix = 2
    while (seen.has(name)) {
      name = `${raw}${suffix++}`
    }
    seen.add(name)
    params.push({
      name,
      in: 'path',
      required: true,
      schema: raw === 'uuid' ? { type: 'string' } : raw === 'hash' ? { type: 'string' } : { type: 'string' },
      description: raw === 'id'
        ? 'Numeric id captured during recording.'
        : raw === 'uuid'
          ? 'UUID captured during recording.'
          : raw === 'hash'
            ? 'Hash-like opaque identifier captured during recording.'
            : `Path parameter '${raw}'.`,
    })
  }
  return params
}

function primaryTag(normalizedPath: string): string {
  const parts = normalizedPath.split('/').filter(Boolean)
  for (const p of parts) {
    if (!p.startsWith('{')) return p
  }
  return 'root'
}

function collectTags(endpoints: EndpointEntry[]): { name: string; description?: string }[] {
  const counts = new Map<string, number>()
  for (const e of endpoints) {
    const t = primaryTag(e.normalizedPath)
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => ({ name, description: `${n} endpoint${n === 1 ? '' : 's'} under /${name}` }))
}

function makeOperationId(e: EndpointEntry): string {
  const path = e.normalizedPath
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith('{') ? `By${capitalize(seg.slice(1, -1))}` : capitalize(seg)))
    .join('')
  return (e.method.toLowerCase() + (path || 'Root')).replace(/[^A-Za-z0-9]/g, '')
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

function parseAll(samples: string[]): unknown[] {
  const out: unknown[] = []
  for (const s of samples) {
    try {
      out.push(JSON.parse(s))
    } catch {
      // skip non-JSON
    }
  }
  return out
}

function countOperations(spec: OpenApiSpec): number {
  let n = 0
  for (const item of Object.values(spec.paths)) {
    for (const k of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      if (item[k]) n++
    }
  }
  return n
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 60) || 'spec'
}

// Build EndpointEntry shapes from a single session's raw apiCalls so the
// session-level OpenAPI emitter can share buildSpec/buildOperation with
// the project-level path. Mirrors the project aggregator's bucketing.
function endpointsFromSession(session: StoredSession): EndpointEntry[] {
  const calls = session.summary.apiCalls ?? []
  const map = new Map<string, EndpointEntry>()
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
    let e = map.get(key)
    if (!e) {
      e = makeEndpointEntry(c, hostname, normalizedPath, key)
      map.set(key, e)
    }
    e.callCount++
    e.statuses[c.status] = (e.statuses[c.status] ?? 0) + 1
    if (c.responseBody && e.responseSamples.length < 25) e.responseSamples.push(c.responseBody)
    if (c.requestBody && e.requestSamples.length < 25) e.requestSamples.push(c.requestBody)
  }
  return [...map.values()]
}

function makeEndpointEntry(c: ApiCall, hostname: string, normalizedPath: string, key: string): EndpointEntry {
  return {
    key,
    method: c.method.toUpperCase(),
    hostname,
    normalizedPath,
    callCount: 0,
    sessionCount: 1,
    statuses: {},
    responseSamples: [],
    requestSamples: [],
    sampleCall: c,
    responseMimeType: c.responseMimeType ?? '',
    ...(c.graphql
      ? { graphql: { operationName: c.graphql.operationName, operationType: c.graphql.operationType } }
      : {}),
  }
}

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
