import type { ProjectDigest, EndpointEntry, RouteEntry, AssetEntry } from './project-aggregate'
import { inferJsonSchema, type JsonSchema } from './schema-infer'
import type { GraphqlOperation } from './graphql-extract'

export interface ProjectDiff {
  left: { host: string; sessionCount: number; lastCapturedAt: number }
  right: { host: string; sessionCount: number; lastCapturedAt: number }

  endpoints: {
    addedInRight: EndpointEntry[]
    removedInRight: EndpointEntry[]
    changed: ChangedEndpoint[]
    bothUnchanged: number
  }
  routes: {
    addedInRight: RouteEntry[]
    removedInRight: RouteEntry[]
    bothUnchanged: number
  }
  graphqlOps: {
    addedInRight: GraphqlOperation[]
    removedInRight: GraphqlOperation[]
    changed: ChangedGraphqlOp[]
    bothUnchanged: number
  }
  staticAssets: {
    addedInRight: AssetEntry[]
    removedInRight: AssetEntry[]
    bothUnchanged: number
  }
}

export interface ChangedEndpoint {
  // Key without host so the diff is meaningful across hosts (staging vs prod).
  key: string
  method: string
  normalizedPath: string
  left: EndpointEntry
  right: EndpointEntry
  // Status codes the right project saw but the left didn't, and vice versa.
  statusesAddedInRight: number[]
  statusesRemovedInRight: number[]
  // Response schema diff lines, e.g. "[+] foo.bar (string)".
  // Empty when both have no samples or schemas are identical.
  schemaChanges: SchemaChangeLine[]
}

export interface ChangedGraphqlOp {
  name: string
  left: GraphqlOperation
  right: GraphqlOperation
  // Variable types the right has that the left didn't (or vice versa).
  variablesAddedInRight: { name: string; type: string }[]
  variablesRemovedInRight: { name: string; type: string }[]
  variablesTypeChanged: { name: string; leftType: string; rightType: string }[]
  // __typename values added/removed.
  typenamesAddedInRight: string[]
  typenamesRemovedInRight: string[]
}

export interface SchemaChangeLine {
  kind: '+' | '-' | '~'
  path: string
  detail: string
}

// Compares two project digests. "Left" is treated as the baseline, "right"
// as the comparison. Endpoint keys deliberately strip the hostname so
// /api/foo on staging.example.com compares to /api/foo on prod.example.com.
// Status histograms and response schemas (inferred from union samples) are
// diffed in place to surface drift, not just presence/absence.
export function compareProjects(left: ProjectDigest, right: ProjectDigest): ProjectDiff {
  const endpoints = diffEndpoints(left.endpoints, right.endpoints)
  const routes = diffRoutes(left.routes, right.routes)
  const graphqlOps = diffGraphqlOps(left.graphqlOps, right.graphqlOps)
  const staticAssets = diffStaticAssets(left.staticAssets, right.staticAssets)
  return {
    left: { host: left.host, sessionCount: left.sessionCount, lastCapturedAt: left.lastCapturedAt },
    right: { host: right.host, sessionCount: right.sessionCount, lastCapturedAt: right.lastCapturedAt },
    endpoints,
    routes,
    graphqlOps,
    staticAssets,
  }
}

// ---- Endpoints --------------------------------------------------------------

function diffEndpoints(left: EndpointEntry[], right: EndpointEntry[]): ProjectDiff['endpoints'] {
  // GraphQL endpoints are handled by diffGraphqlOps — exclude them here so
  // /graphql doesn't show up as one giant endpoint in the REST diff.
  const lByKey = new Map<string, EndpointEntry>()
  for (const e of left) if (!e.graphql) lByKey.set(restKey(e), e)
  const rByKey = new Map<string, EndpointEntry>()
  for (const e of right) if (!e.graphql) rByKey.set(restKey(e), e)

  const addedInRight: EndpointEntry[] = []
  const removedInRight: EndpointEntry[] = []
  const changed: ChangedEndpoint[] = []
  let bothUnchanged = 0

  for (const [k, r] of rByKey) {
    const l = lByKey.get(k)
    if (!l) {
      addedInRight.push(r)
      continue
    }
    const ch = compareEndpoint(k, l, r)
    if (ch) changed.push(ch)
    else bothUnchanged++
  }
  for (const [k, l] of lByKey) {
    if (!rByKey.has(k)) removedInRight.push(l)
  }

  addedInRight.sort(byPath)
  removedInRight.sort(byPath)
  changed.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath))
  return { addedInRight, removedInRight, changed, bothUnchanged }
}

function restKey(e: EndpointEntry): string {
  return `${e.method} ${e.normalizedPath}`
}

function byPath(a: EndpointEntry, b: EndpointEntry): number {
  return a.normalizedPath.localeCompare(b.normalizedPath) || a.method.localeCompare(b.method)
}

function compareEndpoint(key: string, l: EndpointEntry, r: EndpointEntry): ChangedEndpoint | null {
  const lStatuses = new Set(Object.keys(l.statuses).map(Number))
  const rStatuses = new Set(Object.keys(r.statuses).map(Number))
  const statusesAddedInRight = [...rStatuses].filter((s) => !lStatuses.has(s)).sort((a, b) => a - b)
  const statusesRemovedInRight = [...lStatuses].filter((s) => !rStatuses.has(s)).sort((a, b) => a - b)

  const leftSchema = inferSchemaFor(l)
  const rightSchema = inferSchemaFor(r)
  const schemaChanges = diffJsonSchemas(leftSchema, rightSchema, '')

  if (
    statusesAddedInRight.length === 0 &&
    statusesRemovedInRight.length === 0 &&
    schemaChanges.length === 0
  ) {
    return null
  }
  return {
    key,
    method: l.method,
    normalizedPath: l.normalizedPath,
    left: l,
    right: r,
    statusesAddedInRight,
    statusesRemovedInRight,
    schemaChanges,
  }
}

function inferSchemaFor(e: EndpointEntry): JsonSchema | null {
  const samples: unknown[] = []
  for (const s of e.responseSamples.slice(0, 10)) {
    try { samples.push(JSON.parse(s)) } catch { /* skip */ }
  }
  return inferJsonSchema(samples)
}

// ---- JSON Schema diff -------------------------------------------------------

// Walks two JSON Schemas in parallel and emits a flat list of change lines.
// Only covers the subset our inferJsonSchema emits — no $ref, no allOf, etc.
function diffJsonSchemas(left: JsonSchema | null, right: JsonSchema | null, basePath: string): SchemaChangeLine[] {
  if (!left && !right) return []
  if (!left && right) {
    return [{ kind: '+', path: basePath || '<root>', detail: `present in right only (${schemaTypeOf(right)})` }]
  }
  if (left && !right) {
    return [{ kind: '-', path: basePath || '<root>', detail: `present in left only (${schemaTypeOf(left)})` }]
  }
  const out: SchemaChangeLine[] = []
  const lt = schemaTypeOf(left!)
  const rt = schemaTypeOf(right!)
  if (lt !== rt) {
    out.push({ kind: '~', path: basePath || '<root>', detail: `type ${lt} → ${rt}` })
    return out
  }
  if (lt === 'object') {
    const l = left as { properties?: Record<string, JsonSchema>; required?: string[] }
    const r = right as { properties?: Record<string, JsonSchema>; required?: string[] }
    const lProps = l.properties ?? {}
    const rProps = r.properties ?? {}
    const lReq = new Set(l.required ?? [])
    const rReq = new Set(r.required ?? [])
    const allKeys = new Set([...Object.keys(lProps), ...Object.keys(rProps)])
    for (const key of [...allKeys].sort()) {
      const childPath = basePath ? `${basePath}.${key}` : key
      const ls = lProps[key]
      const rs = rProps[key]
      if (!ls && rs) {
        out.push({ kind: '+', path: childPath, detail: `new field (${schemaTypeOf(rs)})${rReq.has(key) ? ', required' : ''}` })
      } else if (ls && !rs) {
        out.push({ kind: '-', path: childPath, detail: `removed (${schemaTypeOf(ls)})${lReq.has(key) ? ', was required' : ''}` })
      } else if (ls && rs) {
        out.push(...diffJsonSchemas(ls, rs, childPath))
        // Optionality change
        if (lReq.has(key) && !rReq.has(key)) {
          out.push({ kind: '~', path: childPath, detail: 'required → optional' })
        } else if (!lReq.has(key) && rReq.has(key)) {
          out.push({ kind: '~', path: childPath, detail: 'optional → required' })
        }
      }
    }
    return out
  }
  if (lt === 'array') {
    const l = left as { items: JsonSchema }
    const r = right as { items: JsonSchema }
    return diffJsonSchemas(l.items, r.items, `${basePath || '<root>'}[]`)
  }
  // Scalar — compare enums
  const lEnum = (left as { enum?: unknown[] }).enum
  const rEnum = (right as { enum?: unknown[] }).enum
  if (lEnum || rEnum) {
    const lSet = new Set((lEnum ?? []).map(String))
    const rSet = new Set((rEnum ?? []).map(String))
    const added = [...rSet].filter((v) => !lSet.has(v))
    const removed = [...lSet].filter((v) => !rSet.has(v))
    if (added.length > 0) out.push({ kind: '~', path: basePath || '<root>', detail: `enum + ${added.join(', ')}` })
    if (removed.length > 0) out.push({ kind: '~', path: basePath || '<root>', detail: `enum - ${removed.join(', ')}` })
  }
  return out
}

function schemaTypeOf(s: JsonSchema): string {
  if ('type' in s) return s.type
  if ('oneOf' in s) return 'oneOf'
  return 'any'
}

// ---- Routes -----------------------------------------------------------------

function diffRoutes(left: RouteEntry[], right: RouteEntry[]): ProjectDiff['routes'] {
  const lByKey = new Map<string, RouteEntry>()
  for (const r of left) lByKey.set(r.normalizedPath, r)
  const rByKey = new Map<string, RouteEntry>()
  for (const r of right) rByKey.set(r.normalizedPath, r)

  const addedInRight: RouteEntry[] = []
  const removedInRight: RouteEntry[] = []
  let bothUnchanged = 0
  for (const [k, r] of rByKey) {
    if (lByKey.has(k)) bothUnchanged++
    else addedInRight.push(r)
  }
  for (const [k, l] of lByKey) {
    if (!rByKey.has(k)) removedInRight.push(l)
  }
  addedInRight.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath))
  removedInRight.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath))
  return { addedInRight, removedInRight, bothUnchanged }
}

// ---- GraphQL ----------------------------------------------------------------

function diffGraphqlOps(left: GraphqlOperation[], right: GraphqlOperation[]): ProjectDiff['graphqlOps'] {
  const lByName = new Map(left.map((o) => [o.name, o]))
  const rByName = new Map(right.map((o) => [o.name, o]))

  const addedInRight: GraphqlOperation[] = []
  const removedInRight: GraphqlOperation[] = []
  const changed: ChangedGraphqlOp[] = []
  let bothUnchanged = 0

  for (const [name, r] of rByName) {
    const l = lByName.get(name)
    if (!l) {
      addedInRight.push(r)
      continue
    }
    const ch = compareGraphqlOp(l, r)
    if (ch) changed.push(ch)
    else bothUnchanged++
  }
  for (const [name, l] of lByName) {
    if (!rByName.has(name)) removedInRight.push(l)
  }
  return { addedInRight, removedInRight, changed, bothUnchanged }
}

function compareGraphqlOp(l: GraphqlOperation, r: GraphqlOperation): ChangedGraphqlOp | null {
  const lVars = l.variableTypes
  const rVars = r.variableTypes
  const allVars = new Set([...Object.keys(lVars), ...Object.keys(rVars)])
  const variablesAddedInRight: { name: string; type: string }[] = []
  const variablesRemovedInRight: { name: string; type: string }[] = []
  const variablesTypeChanged: { name: string; leftType: string; rightType: string }[] = []
  for (const v of [...allVars].sort()) {
    const lt = lVars[v]
    const rt = rVars[v]
    if (!lt && rt) variablesAddedInRight.push({ name: v, type: rt })
    else if (lt && !rt) variablesRemovedInRight.push({ name: v, type: lt })
    else if (lt && rt && lt !== rt) variablesTypeChanged.push({ name: v, leftType: lt, rightType: rt })
  }
  const lTypenames = new Set(l.typenames)
  const rTypenames = new Set(r.typenames)
  const typenamesAddedInRight = [...rTypenames].filter((t) => !lTypenames.has(t)).sort()
  const typenamesRemovedInRight = [...lTypenames].filter((t) => !rTypenames.has(t)).sort()

  if (
    variablesAddedInRight.length === 0 &&
    variablesRemovedInRight.length === 0 &&
    variablesTypeChanged.length === 0 &&
    typenamesAddedInRight.length === 0 &&
    typenamesRemovedInRight.length === 0
  ) {
    return null
  }
  return {
    name: l.name,
    left: l,
    right: r,
    variablesAddedInRight,
    variablesRemovedInRight,
    variablesTypeChanged,
    typenamesAddedInRight,
    typenamesRemovedInRight,
  }
}

// ---- Static assets ----------------------------------------------------------

function diffStaticAssets(left: AssetEntry[], right: AssetEntry[]): ProjectDiff['staticAssets'] {
  // Compare by pathname so staging vs prod aren't all "added/removed".
  const lByKey = new Map<string, AssetEntry>()
  for (const a of left) lByKey.set(assetKey(a), a)
  const rByKey = new Map<string, AssetEntry>()
  for (const a of right) rByKey.set(assetKey(a), a)

  const addedInRight: AssetEntry[] = []
  const removedInRight: AssetEntry[] = []
  let bothUnchanged = 0
  for (const [k, r] of rByKey) {
    if (lByKey.has(k)) bothUnchanged++
    else addedInRight.push(r)
  }
  for (const [k, l] of lByKey) {
    if (!rByKey.has(k)) removedInRight.push(l)
  }
  addedInRight.sort((a, b) => a.url.localeCompare(b.url))
  removedInRight.sort((a, b) => a.url.localeCompare(b.url))
  return { addedInRight, removedInRight, bothUnchanged }
}

function assetKey(a: AssetEntry): string {
  try {
    return new URL(a.url).pathname
  } catch {
    return a.url
  }
}
