import type { StoredSession } from '@unwrap/protocol'
import type { ProjectDigest, EndpointEntry } from './project-aggregate'

// Minimal Postman Collection v2.1 shapes for the bits we emit.
// Reference: https://schema.postman.com/json/collection/v2.1.0/collection.json
interface PostmanCollection {
  info: {
    name: string
    description: string
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    _postman_id?: string
  }
  variable: { key: string; value: string; type?: string }[]
  item: PostmanItem[]
}

type PostmanItem = PostmanFolder | PostmanRequestItem

interface PostmanFolder {
  name: string
  description?: string
  item: PostmanItem[]
}

interface PostmanRequestItem {
  name: string
  request: {
    method: string
    header?: { key: string; value: string }[]
    url: {
      raw: string
      host: string[]
      path: string[]
      variable?: { key: string; value: string }[]
    }
    body?: {
      mode: 'raw'
      raw: string
      options?: { raw: { language: 'json' } }
    }
    description?: string
  }
  response?: PostmanResponse[]
}

interface PostmanResponse {
  name: string
  status: string
  code: number
  _postman_previewlanguage?: 'json'
  header?: { key: string; value: string }[]
  body?: string
  originalRequest?: PostmanRequestItem['request']
}

export interface PostmanArtifact {
  filename: string
  body: string
  requestCount: number
}

// Convert a project digest into a Postman v2.1 collection. Endpoints are
// foldered by the primary path segment (`/api/users/{id}` → folder `users`)
// so the import lands with a usable structure. URL templating uses Postman's
// `:id` syntax — the OpenAPI spec uses `{id}`, Postman uses `:id`.
export function buildPostmanFromProject(digest: ProjectDigest): PostmanArtifact {
  const restEndpoints = digest.endpoints.filter((e) => !e.graphql)
  const collection = buildCollection({
    name: `${digest.host} (Unwrap capture)`,
    description: `Aggregated from ${digest.sessionCount} captured browser session${digest.sessionCount === 1 ? '' : 's'} of ${digest.host}. baseUrl variable points at the live host — change it to http://localhost:3000 to hit the Unwrap mock server instead.`,
    host: digest.host,
    endpoints: restEndpoints,
  })
  const body = JSON.stringify(collection, null, 2)
  const safeHost = safe(digest.host)
  return {
    filename: `postman-${safeHost}.json`,
    body,
    requestCount: countRequests(collection.item),
  }
}

export function buildPostmanFromSession(session: StoredSession): PostmanArtifact {
  const endpoints = endpointsFromSession(session)
  const restEndpoints = endpoints.filter((e) => !e.graphql)
  const collection = buildCollection({
    name: `${session.summary.meta.host || 'session'} (Unwrap capture)`,
    description: `Captured ${session.summary.meta.startedAt}. baseUrl points at the live host — change to http://localhost:3000 to hit the Unwrap mock server.`,
    host: session.summary.meta.host || 'localhost',
    endpoints: restEndpoints,
  })
  const body = JSON.stringify(collection, null, 2)
  const safeHost = safe(session.summary.meta.host || 'session')
  return {
    filename: `postman-${safeHost}-${session.id.slice(0, 8)}.json`,
    body,
    requestCount: countRequests(collection.item),
  }
}

function buildCollection(opts: { name: string; description: string; host: string; endpoints: EndpointEntry[] }): PostmanCollection {
  // Bucket by primary tag → folder.
  const folders = new Map<string, PostmanRequestItem[]>()
  for (const e of opts.endpoints) {
    const folderName = primaryTag(e.normalizedPath)
    const list = folders.get(folderName) ?? []
    list.push(buildRequestItem(e))
    folders.set(folderName, list)
  }

  const items: PostmanItem[] = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, requests]) => ({
      name,
      description: `${requests.length} endpoint${requests.length === 1 ? '' : 's'} under /${name}`,
      item: requests.sort((a, b) => a.name.localeCompare(b.name)),
    }))

  return {
    info: {
      name: opts.name,
      description: opts.description,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: `https://${opts.host}`, type: 'string' },
    ],
    item: items,
  }
}

function buildRequestItem(e: EndpointEntry): PostmanRequestItem {
  // Postman wants `{{baseUrl}}/api/users/:id` — convert {id} → :id.
  const pmPath = e.normalizedPath.replace(/\{([^}]+)\}/g, ':$1')
  const pathSegments = pmPath.split('/').filter(Boolean)
  const pathVars: { key: string; value: string }[] = []
  for (const seg of pathSegments) {
    if (seg.startsWith(':')) {
      pathVars.push({ key: seg.slice(1), value: '' })
    }
  }

  const requestSample = e.requestSamples[0]
  const isBodyMethod = e.method === 'POST' || e.method === 'PUT' || e.method === 'PATCH'

  const request: PostmanRequestItem['request'] = {
    method: e.method,
    header: [{ key: 'Content-Type', value: 'application/json' }],
    url: {
      raw: `{{baseUrl}}${pmPath}`,
      host: ['{{baseUrl}}'],
      path: pathSegments,
      ...(pathVars.length > 0 ? { variable: pathVars } : {}),
    },
    description: `Inferred from ${e.callCount} captured call${e.callCount === 1 ? '' : 's'} across ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}. Status codes seen: ${Object.entries(e.statuses).map(([s, n]) => `${s}×${n}`).join(', ')}.`,
    ...(isBodyMethod && requestSample
      ? {
          body: {
            mode: 'raw',
            raw: prettyJson(requestSample),
            options: { raw: { language: 'json' } },
          },
        }
      : {}),
  }

  // Attach sample responses (up to 3) so Postman's "Examples" panel shows real data.
  const responses: PostmanResponse[] = []
  for (let i = 0; i < Math.min(3, e.responseSamples.length); i++) {
    const sample = e.responseSamples[i]!
    const statusCode = Object.keys(e.statuses).map(Number)[0] ?? 200
    responses.push({
      name: `Captured sample ${i + 1}`,
      status: statusText(statusCode),
      code: statusCode,
      _postman_previewlanguage: 'json',
      header: [{ key: 'Content-Type', value: e.responseMimeType || 'application/json' }],
      body: prettyJson(sample),
      originalRequest: request,
    })
  }

  return {
    name: `${e.method} ${e.normalizedPath}`,
    request,
    ...(responses.length > 0 ? { response: responses } : {}),
  }
}

function primaryTag(normalizedPath: string): string {
  const parts = normalizedPath.split('/').filter(Boolean)
  for (const p of parts) {
    if (!p.startsWith('{')) return p
  }
  return 'root'
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function statusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    500: 'Internal Server Error',
  }
  return map[code] ?? String(code)
}

function countRequests(items: PostmanItem[]): number {
  let n = 0
  for (const it of items) {
    if ('request' in it) n++
    else n += countRequests(it.item)
  }
  return n
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 60) || 'collection'
}

function endpointsFromSession(session: StoredSession): EndpointEntry[] {
  // Mirror of openapi-export's session normalizer. Duplicated rather than
  // extracted to a shared module because the two will likely diverge as
  // each format grows its own hints (auth, examples, etc.).
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
      e = {
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
      map.set(key, e)
    }
    e.callCount++
    e.statuses[c.status] = (e.statuses[c.status] ?? 0) + 1
    if (c.responseBody && e.responseSamples.length < 25) e.responseSamples.push(c.responseBody)
    if (c.requestBody && e.requestSamples.length < 25) e.requestSamples.push(c.requestBody)
  }
  return [...map.values()]
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
