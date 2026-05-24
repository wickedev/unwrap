import type { ApiCall, StoredSession } from '@unwrap/protocol'

export interface GraphqlOperation {
  // Operation name (or `Op${hash}` for anonymous ones — keeps the file
  // valid when there are unnamed queries).
  name: string
  operationType: 'query' | 'mutation' | 'subscription'
  // Raw query string, taken from the request body verbatim.
  query: string
  // Stable identifier used to dedupe — FNV-1a hash from the extension.
  queryHash: string
  // Variable types inferred from every captured `variables` payload.
  // Field is the variable name, value is a TS-shaped type literal we
  // can render into the SDL.
  variableTypes: Record<string, string>
  // Sample of __typename values seen anywhere in the response data tree.
  // Helps the reader understand which Object types this op touches.
  typenames: string[]
  // Number of times this operation was called.
  callCount: number
  // First-seen URL — usually the GraphQL endpoint.
  endpoint: string
}

export interface GraphqlSchemaArtifact {
  filename: string
  body: string
  operationCount: number
  // Operation name → printable summary, for surfacing in the inventory page.
  operations: GraphqlOperation[]
}

// Walks every captured ApiCall that the extension flagged as GraphQL,
// pulls the raw query out of the request body, dedupes by queryHash,
// and emits a single .graphql document with one operation per unique
// query. Variable types are inferred from `variables`, and __typename
// values from response data are appended as comments so the reader can
// see which Object types each op returns. Returns null when there were
// no GraphQL calls — caller suppresses the download link in that case.
export function extractGraphqlOperations(session: StoredSession): GraphqlSchemaArtifact | null {
  const calls = session.summary.apiCalls ?? []
  const gqlCalls = calls.filter((c) => c.graphql)
  if (gqlCalls.length === 0) return null

  const byHash = new Map<string, GraphqlOperation>()
  for (const c of gqlCalls) {
    const parsed = parseGraphqlRequest(c)
    if (!parsed) continue
    const { query, operationName, operationType, variables } = parsed
    const hash = c.graphql!.queryHash ?? simpleHash(query)
    const fallbackName = operationName ?? `Op${hash}`
    let op = byHash.get(hash)
    if (!op) {
      op = {
        name: fallbackName,
        operationType,
        query: query.trim(),
        queryHash: hash,
        variableTypes: {},
        typenames: [],
        callCount: 0,
        endpoint: c.url,
      }
      byHash.set(hash, op)
    }
    op.callCount++
    mergeVariableTypes(op.variableTypes, variables)
    if (c.responseBody) {
      collectTypenames(c.responseBody, op.typenames)
    }
  }

  if (byHash.size === 0) return null

  const operations = [...byHash.values()].sort((a, b) => a.name.localeCompare(b.name))
  const body = renderGraphqlDocument(session, operations)
  const safeHost = (session.summary.meta.host || 'session').replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 60)
  return {
    filename: `operations-${safeHost}-${session.id.slice(0, 8)}.graphql`,
    body,
    operationCount: operations.length,
    operations,
  }
}

interface ParsedGqlRequest {
  query: string
  operationName?: string
  operationType: 'query' | 'mutation' | 'subscription'
  variables: Record<string, unknown> | null
}

function parseGraphqlRequest(c: ApiCall): ParsedGqlRequest | null {
  if (!c.requestBody) return null
  let body: unknown
  try {
    body = JSON.parse(c.requestBody)
  } catch {
    return null
  }
  // Some clients batch operations into an array — take the first entry.
  const first = Array.isArray(body) ? body[0] : body
  if (!first || typeof first !== 'object') return null
  const f = first as Record<string, unknown>
  const query = typeof f.query === 'string' ? f.query : null
  if (!query) return null
  const operationName = typeof f.operationName === 'string' ? f.operationName : undefined
  const variables = f.variables && typeof f.variables === 'object' ? (f.variables as Record<string, unknown>) : null
  const opType = (c.graphql?.operationType ??
    (query.match(/^\s*(query|mutation|subscription)\b/i)?.[1]?.toLowerCase() as
      | 'query'
      | 'mutation'
      | 'subscription'
      | undefined) ??
    'query') as 'query' | 'mutation' | 'subscription'
  return { query, operationName, operationType: opType, variables }
}

function mergeVariableTypes(into: Record<string, string>, vars: Record<string, unknown> | null) {
  if (!vars) return
  for (const [k, v] of Object.entries(vars)) {
    const t = inferGraphqlType(v)
    if (!t) continue
    const prev = into[k]
    if (!prev) {
      into[k] = t
    } else if (prev !== t && !prev.split(' | ').includes(t)) {
      into[k] = `${prev} | ${t}`
    }
  }
}

function inferGraphqlType(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return 'String'
  if (typeof v === 'boolean') return 'Boolean'
  if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Float'
  if (Array.isArray(v)) {
    const inner = v.length > 0 ? inferGraphqlType(v[0]) ?? 'JSON' : 'JSON'
    return `[${inner}]`
  }
  // Object literal — model as JSON input type, since we don't know the
  // input type name. Reader can rename if they recover the real schema.
  return 'JSON'
}

function collectTypenames(responseBody: string, out: string[]) {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseBody)
  } catch {
    return
  }
  const seen = new Set(out)
  const stack: unknown[] = [parsed]
  let visited = 0
  while (stack.length && visited < 5000) {
    visited++
    const node = stack.pop()
    if (node && typeof node === 'object') {
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item)
      } else {
        const obj = node as Record<string, unknown>
        const tn = obj.__typename
        if (typeof tn === 'string' && !seen.has(tn)) {
          seen.add(tn)
          out.push(tn)
        }
        for (const k of Object.keys(obj)) stack.push(obj[k])
      }
    }
  }
  out.sort()
}

function renderGraphqlDocument(session: StoredSession, operations: GraphqlOperation[]): string {
  const meta = session.summary.meta
  const lines: string[] = []
  lines.push(`# GraphQL operations captured from ${meta.host || 'unknown host'}`)
  lines.push(`# Session ${session.id} · captured ${meta.startedAt}`)
  lines.push(`# ${operations.length} unique operation${operations.length === 1 ? '' : 's'} (deduped by query hash)`)
  lines.push('#')
  lines.push('# Each operation block: variables inferred from every captured call (scalar')
  lines.push('# widening across calls); typenames from response __typename values.')
  lines.push('# Query bodies are taken verbatim from the wire — fragments are inlined if')
  lines.push('# the client sent them inlined, separate if it sent them separate.')
  lines.push('')

  for (const op of operations) {
    lines.push(`# ──────────────────────────────────────────────────────────────────`)
    lines.push(`# ${op.name} · ${op.callCount} call${op.callCount === 1 ? '' : 's'} · endpoint ${op.endpoint}`)
    if (op.typenames.length > 0) {
      lines.push(`# Object types seen in response: ${op.typenames.join(', ')}`)
    }
    if (Object.keys(op.variableTypes).length > 0) {
      lines.push(`# Inferred variable types:`)
      for (const [k, t] of Object.entries(op.variableTypes)) {
        lines.push(`#   $${k}: ${t}`)
      }
    }
    lines.push('')
    lines.push(op.query)
    lines.push('')
  }
  return lines.join('\n')
}

function simpleHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
