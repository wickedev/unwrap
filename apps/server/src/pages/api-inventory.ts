import { html, raw } from 'hono/html'
import type { ApiCall, StoredSession } from '@unwrap/protocol'
import { Layout, type Renderable } from './layout'
import { inferType } from '../schema-infer'
import { extractGraphqlOperations, type GraphqlOperation } from '../graphql-extract'

interface EndpointGroup {
  key: string
  method: string
  normalizedPath: string
  hostname: string
  statuses: Map<number, number> // status → count
  calls: ApiCall[]
  graphql?: { operationName?: string; operationType?: string }
}

export function ApiInventoryPage({
  email,
  session,
}: {
  email: string
  session: StoredSession
}): Renderable {
  const calls = session.summary.apiCalls ?? []
  const groups = groupEndpoints(calls)
  const graphqlGroups = groups.filter((g) => g.graphql)
  const restGroups = groups.filter((g) => !g.graphql)
  const graphqlArtifact = extractGraphqlOperations(session)
  const graphqlByName = new Map<string, GraphqlOperation>()
  if (graphqlArtifact) {
    for (const op of graphqlArtifact.operations) graphqlByName.set(op.name, op)
  }

  return Layout({
    title: 'API inventory',
    email,
    body: html`
      <p><a href="/sessions/${session.id}">← back to session ${session.id.slice(0, 8)}</a></p>
      <h2 style="margin-top: 4px;">API inventory · ${session.summary.meta.host || '(no host)'}</h2>
      <p class="muted">Every HTTP request that looked API-shaped during the capture, grouped by endpoint signature.</p>

      <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px;">
        ${kpi('Total calls', calls.length, 'var(--fg)')}
        ${kpi('Unique endpoints', restGroups.length, '#2f6feb')}
        ${kpi('GraphQL ops', graphqlGroups.length, '#7c4ac2')}
        ${kpi('Hosts', new Set(groups.map((g) => g.hostname)).size, 'var(--muted)')}
      </div>

      ${restGroups.length > 0
        ? html`<div class="card" style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 6px;">
              <strong style="font-size: 13px;">↓ API exports (this session)</strong>
              <span class="meta" style="font-size: 11px;">For richer schemas, see the project page (aggregates across every capture).</span>
            </div>
            <div class="meta" style="font-size: 11px; margin-bottom: 10px;">
              OpenAPI 3.0 spec + Postman v2.1 collection for the REST endpoints in this session. Generate a TypeScript SDK with <code>npx openapi-typescript &lt;file&gt; -o client.ts</code>.
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <a class="btn secondary" href="/sessions/${session.id}/openapi.json" download>↓ OpenAPI 3.0 (.json)</a>
              <a class="btn secondary" href="/sessions/${session.id}/postman.json" download>↓ Postman collection (.json)</a>
            </div>
          </div>`
        : ''}

      ${calls.length > 0 || (session.summary.staticAssets?.length ?? 0) > 0
        ? html`<div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; border-color: var(--accent);">
            <div style="min-width: 0;">
              <strong style="font-size: 13px;">↓ Runnable local clone (this session)</strong>
              <div class="meta" style="font-size: 11px; margin-top: 2px;">
                Single zip: captured frontend + mock server + <code>run.sh</code>. Unzip → <code>./run.sh</code> → <code>http://localhost:8080</code>. For an aggregated clone across every capture of this host, see the project page.
              </div>
            </div>
            <a class="btn" href="/sessions/${session.id}/clone.zip" download>↓ Download clone.zip</a>
          </div>`
        : ''}

      ${calls.length > 0
        ? html`<div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
            <div style="min-width: 0;">
              <strong style="font-size: 13px;">Mock server</strong>
              <div class="meta" style="font-size: 11px; margin-top: 2px;">
                Single-file Node.js script. No deps — just run <code>node mock-server.mjs</code> and point your dev frontend at <code>http://localhost:3000</code>. CORS open. <strong>Stateful replay</strong>: each route walks through the sequence of responses captured during recording (login → fetch → mutate → refetch reproduces). <code>POST /__unwrap_reset</code> to rewind.
              </div>
            </div>
            <a class="btn" href="/sessions/${session.id}/api/mock" download>↓ Download mock server</a>
          </div>`
        : ''}

      ${graphqlArtifact
        ? html`<div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
            <div style="min-width: 0;">
              <strong style="font-size: 13px;">GraphQL operations</strong>
              <div class="meta" style="font-size: 11px; margin-top: 2px;">
                ${graphqlArtifact.operationCount} unique operation${graphqlArtifact.operationCount === 1 ? '' : 's'} extracted from captured request bodies. Variable types inferred from <code>variables</code> payloads; <code>__typename</code> values from response data appended as comments per op. Use as a starting point for schema regeneration or client codegen.
              </div>
            </div>
            <a class="btn" href="/sessions/${session.id}/graphql.txt" download>↓ Download operations.graphql</a>
          </div>`
        : ''}

      ${(session.summary.staticAssets?.length ?? 0) > 0
        ? html`<div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
            <div style="min-width: 0;">
              <strong style="font-size: 13px;">Static mirror</strong>
              <div class="meta" style="font-size: 11px; margin-top: 2px;">
                ${session.summary.staticAssets!.length} captured asset${session.summary.staticAssets!.length === 1 ? '' : 's'} (HTML / CSS / JS / SVG) bundled into a zip preserving path structure. Binary refs (image / font) listed in <code>MIRROR.md</code>. Pair with the mock server above for a fully local clone.
              </div>
            </div>
            <a class="btn" href="/sessions/${session.id}/static.zip" download>↓ Download static mirror</a>
          </div>`
        : ''}

      ${calls.length === 0
        ? html`<div class="card"><div class="muted">No API calls captured. The extension only sends JSON / GraphQL / mutation traffic to keep uploads small.</div></div>`
        : ''}

      ${graphqlGroups.length > 0
        ? html`<div class="section">
            <h2>GraphQL operations</h2>
            ${graphqlGroups.map((g) => renderGroup(g, graphqlByName))}
          </div>`
        : ''}

      ${restGroups.length > 0
        ? html`<div class="section">
            <h2>REST / RPC endpoints</h2>
            ${restGroups.map((g) => renderGroup(g, graphqlByName))}
          </div>`
        : ''}

      <style>${raw(API_CSS)}</style>
    `,
  })
}

function renderGroup(group: EndpointGroup, graphqlByName: Map<string, GraphqlOperation>): Renderable {
  const sample = group.calls[0]!
  const gqlOp = group.graphql?.operationName ? graphqlByName.get(group.graphql.operationName) : undefined
  const responseSamples = group.calls
    .map((c) => c.responseBody)
    .filter((b): b is string => !!b)
    .map((b) => tryParse(b))
    .filter((j) => j !== null)
  const requestSamples = group.calls
    .map((c) => c.requestBody)
    .filter((b): b is string => !!b)
    .map((b) => tryParse(b))
    .filter((j) => j !== null)

  const responseSchema = responseSamples.length > 0 ? inferType(responseSamples, 'Response') : null
  const requestSchema = requestSamples.length > 0 ? inferType(requestSamples, 'Request') : null

  const statusList = [...group.statuses.entries()]
    .sort(([a], [b]) => a - b)
    .map(([s, n]) => `${s}×${n}`)
    .join(' · ')

  const curl = buildCurl(sample)
  const curlId = `curl-${group.key.replace(/[^a-z0-9]/gi, '_')}`

  return html`<div class="endpoint">
    <div class="endpoint-head">
      <div class="endpoint-id">
        <span class="method m-${group.method.toLowerCase()}">${group.method}</span>
        <code>${group.normalizedPath}</code>
        ${group.graphql?.operationName
          ? html`<span class="gql-op">${group.graphql.operationType ?? 'query'} ${group.graphql.operationName}</span>`
          : ''}
      </div>
      <div class="endpoint-meta">
        <span title="host">${group.hostname}</span>
        · ${group.calls.length} call${group.calls.length === 1 ? '' : 's'}
        · ${statusList}
      </div>
    </div>

    ${gqlOp
      ? html`<details class="endpoint-section" open>
          <summary>GraphQL operation — ${gqlOp.operationType} ${gqlOp.name}${Object.keys(gqlOp.variableTypes).length > 0 ? ` · ${Object.keys(gqlOp.variableTypes).length} variable${Object.keys(gqlOp.variableTypes).length === 1 ? '' : 's'}` : ''}${gqlOp.typenames.length > 0 ? ` · returns ${gqlOp.typenames.join(', ')}` : ''}</summary>
          ${Object.keys(gqlOp.variableTypes).length > 0
            ? html`<pre style="margin-bottom: 6px;"><code>${formatGqlVariables(gqlOp.variableTypes)}</code></pre>`
            : ''}
          <pre><code>${truncateForDisplay(gqlOp.query, 4000)}</code></pre>
        </details>`
      : ''}

    ${requestSchema
      ? html`<details class="endpoint-section">
          <summary>Request body type (TypeScript)</summary>
          <pre><code>${requestSchema}</code></pre>
        </details>`
      : ''}

    ${responseSchema
      ? html`<details class="endpoint-section" open>
          <summary>Response type (TypeScript) — inferred from ${responseSamples.length} sample${responseSamples.length === 1 ? '' : 's'}</summary>
          <pre><code>${responseSchema}</code></pre>
        </details>`
      : ''}

    ${sample.responseBody
      ? html`<details class="endpoint-section">
          <summary>Sample response (${sample.status} · ${sample.responseMimeType || '?'}${sample.responseSize ? ` · ${formatBytes(sample.responseSize)}` : ''})</summary>
          <pre><code>${truncateForDisplay(formatJsonish(sample.responseBody), 4000)}</code></pre>
        </details>`
      : ''}

    <details class="endpoint-section">
      <summary>Copy as cURL</summary>
      <pre id="${curlId}"><code>${curl}</code></pre>
      <button onclick="navigator.clipboard.writeText(document.getElementById('${curlId}').innerText); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy',1500)">Copy</button>
    </details>
  </div>`
}

function groupEndpoints(calls: ApiCall[]): EndpointGroup[] {
  const groups = new Map<string, EndpointGroup>()
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
    const key = `${c.method} ${hostname}${normalizedPath}${gqlKey ? `#${gqlKey}` : ''}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        method: c.method.toUpperCase(),
        normalizedPath,
        hostname,
        statuses: new Map(),
        calls: [],
        ...(c.graphql ? { graphql: { operationName: c.graphql.operationName, operationType: c.graphql.operationType } } : {}),
      }
      groups.set(key, g)
    }
    g.calls.push(c)
    g.statuses.set(c.status, (g.statuses.get(c.status) ?? 0) + 1)
  }
  // Sort: GraphQL first, then by call count desc
  return [...groups.values()].sort((a, b) => {
    if (!!a.graphql !== !!b.graphql) return a.graphql ? -1 : 1
    return b.calls.length - a.calls.length
  })
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

function buildCurl(call: ApiCall): string {
  const parts: string[] = [`curl -X ${call.method.toUpperCase()} ${q(call.url)}`]
  const headers = call.requestHeaders ?? {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (lower === 'host' || lower === 'content-length' || lower.startsWith(':')) continue
    parts.push(`  -H ${q(`${k}: ${v}`)}`)
  }
  if (call.requestBody) {
    parts.push(`  --data ${q(truncateForDisplay(call.requestBody, 4000))}`)
  }
  return parts.join(' \\\n')
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function formatJsonish(s: string): string {
  const parsed = tryParse(s)
  if (parsed === null) return s
  try {
    return JSON.stringify(parsed, null, 2)
  } catch {
    return s
  }
}

function truncateForDisplay(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more chars)`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function formatGqlVariables(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, t]) => `$${k}: ${t}`).join('\n')
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

const API_CSS = `
.endpoint { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: var(--bg); }
.endpoint-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; margin-bottom: 8px; }
.endpoint-id { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.endpoint-id code { font-size: 12px; word-break: break-all; }
.endpoint-meta { color: var(--muted); font-size: 11px; }
.method { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: white; }
.method.m-get { background: #2f6feb; }
.method.m-post { background: #1f9d55; }
.method.m-put, .method.m-patch { background: #b88300; }
.method.m-delete { background: #d64545; }
.method:not(.m-get):not(.m-post):not(.m-put):not(.m-patch):not(.m-delete) { background: #8c8c8c; }
.gql-op { font-size: 11px; color: #7c4ac2; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.endpoint-section { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
.endpoint-section summary { cursor: pointer; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.endpoint-section pre { margin: 6px 0 0; font-size: 11px; max-height: 400px; }
.endpoint-section button { font-size: 11px; padding: 3px 8px; margin-top: 6px; border: 1px solid var(--border); border-radius: 4px; background: transparent; cursor: pointer; color: var(--fg); }
`
