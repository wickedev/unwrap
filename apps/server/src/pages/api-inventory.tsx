import * as React from 'react'
import { Layout } from './_layout'
import { Card, CardContent } from '@unwrap/ui'
import { Button } from '@unwrap/ui'
import { MethodPill } from './project'
import { cn } from '@unwrap/ui'
import type { ApiCall, StoredSession } from '@unwrap/protocol'
import { inferType } from '../schema-infer'
import { extractGraphqlOperations, type GraphqlOperation } from '../graphql-extract'

interface EndpointGroup {
  key: string
  method: string
  normalizedPath: string
  hostname: string
  statuses: Map<number, number>
  calls: ApiCall[]
  graphql?: { operationName?: string; operationType?: string }
}

export function ApiInventoryPage({ email, session }: { email: string; session: StoredSession }) {
  const calls = session.summary.apiCalls ?? []
  const groups = groupEndpoints(calls)
  const graphqlGroups = groups.filter((g) => g.graphql)
  const restGroups = groups.filter((g) => !g.graphql)
  const graphqlArtifact = extractGraphqlOperations(session)
  const graphqlByName = new Map<string, GraphqlOperation>()
  if (graphqlArtifact) for (const op of graphqlArtifact.operations) graphqlByName.set(op.name, op)
  const staticCount = session.summary.staticAssets?.length ?? 0

  return (
    <Layout email={email} wide>
      <p className="m-0 mb-2"><a href={`/sessions/${session.id}`} className="text-primary text-sm">← back to session {session.id.slice(0, 8)}</a></p>
      <h2 className="m-0 text-xl font-bold">API inventory · {session.summary.meta.host || '(no host)'}</h2>
      <p className="text-xs text-muted-foreground mt-1 mb-4">Every HTTP request that looked API-shaped during the capture, grouped by endpoint signature.</p>

      <Card className="mb-4">
        <CardContent className="p-4 grid gap-2 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
          <Kpi label="Total calls" value={calls.length} color="text-foreground" />
          <Kpi label="Unique endpoints" value={restGroups.length} color="text-primary" />
          <Kpi label="GraphQL ops" value={graphqlGroups.length} color="text-purple-500" />
          <Kpi label="Hosts" value={new Set(groups.map((g) => g.hostname)).size} color="text-muted-foreground" />
        </CardContent>
      </Card>

      {restGroups.length > 0 && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="flex justify-between items-baseline flex-wrap gap-2 mb-1">
              <strong className="text-sm">↓ API exports (this session)</strong>
              <span className="text-xs text-muted-foreground">For richer schemas, see the project page (aggregates across every capture).</span>
            </div>
            <div className="text-xs text-muted-foreground mb-3">
              OpenAPI 3.0 spec + Postman v2.1 collection for the REST endpoints in this session. Generate a TypeScript SDK with <code className="rounded bg-muted px-1.5 py-0.5">npx openapi-typescript &lt;file&gt; -o client.ts</code>.
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" asChild><a href={`/sessions/${session.id}/openapi.json`} download>↓ OpenAPI 3.0 (.json)</a></Button>
              <Button variant="secondary" asChild><a href={`/sessions/${session.id}/postman.json`} download>↓ Postman collection (.json)</a></Button>
            </div>
          </CardContent>
        </Card>
      )}

      {(calls.length > 0 || staticCount > 0) && (
        <Card className="mb-4 border-primary/40">
          <CardContent className="p-4 flex gap-3 items-center justify-between flex-wrap">
            <div className="min-w-0">
              <strong className="text-sm">↓ Runnable local clone (this session)</strong>
              <div className="text-xs text-muted-foreground mt-0.5">
                Single zip: captured frontend + mock server + <code className="rounded bg-muted px-1 py-0.5">run.sh</code>. Unzip → <code className="rounded bg-muted px-1 py-0.5">./run.sh</code> → <code className="rounded bg-muted px-1 py-0.5">http://localhost:8080</code>. For an aggregated clone across every capture of this host, see the project page.
              </div>
            </div>
            <Button asChild><a href={`/sessions/${session.id}/clone.zip`} download>↓ Download clone.zip</a></Button>
          </CardContent>
        </Card>
      )}

      {calls.length > 0 && (
        <Card className="mb-4">
          <CardContent className="p-4 flex gap-3 items-center justify-between flex-wrap">
            <div className="min-w-0">
              <strong className="text-sm">Mock server</strong>
              <div className="text-xs text-muted-foreground mt-0.5">
                Single-file Node.js script. No deps — just run <code className="rounded bg-muted px-1 py-0.5">node mock-server.mjs</code> and point your dev frontend at <code className="rounded bg-muted px-1 py-0.5">http://localhost:3000</code>. CORS open. <strong>Stateful replay</strong>: each route walks through the sequence of responses captured during recording (login → fetch → mutate → refetch reproduces). <code className="rounded bg-muted px-1 py-0.5">POST /__unwrap_reset</code> to rewind.
              </div>
            </div>
            <Button asChild><a href={`/sessions/${session.id}/api/mock`} download>↓ Download mock server</a></Button>
          </CardContent>
        </Card>
      )}

      {graphqlArtifact && (
        <Card className="mb-4">
          <CardContent className="p-4 flex gap-3 items-center justify-between flex-wrap">
            <div className="min-w-0">
              <strong className="text-sm">GraphQL operations</strong>
              <div className="text-xs text-muted-foreground mt-0.5">
                {graphqlArtifact.operationCount} unique operation{graphqlArtifact.operationCount === 1 ? '' : 's'} extracted from captured request bodies. Variable types inferred from <code className="rounded bg-muted px-1 py-0.5">variables</code> payloads; <code className="rounded bg-muted px-1 py-0.5">__typename</code> values from response data appended as comments per op. Use as a starting point for schema regeneration or client codegen.
              </div>
            </div>
            <Button asChild><a href={`/sessions/${session.id}/graphql.txt`} download>↓ Download operations.graphql</a></Button>
          </CardContent>
        </Card>
      )}

      {staticCount > 0 && (
        <Card className="mb-4">
          <CardContent className="p-4 flex gap-3 items-center justify-between flex-wrap">
            <div className="min-w-0">
              <strong className="text-sm">Static mirror</strong>
              <div className="text-xs text-muted-foreground mt-0.5">
                {staticCount} captured asset{staticCount === 1 ? '' : 's'} (HTML / CSS / JS / SVG) bundled into a zip preserving path structure. Binary refs (image / font) listed in <code className="rounded bg-muted px-1 py-0.5">MIRROR.md</code>. Pair with the mock server above for a fully local clone.
              </div>
            </div>
            <Button asChild><a href={`/sessions/${session.id}/static.zip`} download>↓ Download static mirror</a></Button>
          </CardContent>
        </Card>
      )}

      {calls.length === 0 && (
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">No API calls captured. The extension only sends JSON / GraphQL / mutation traffic to keep uploads small.</div></CardContent></Card>
      )}

      {graphqlGroups.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold m-0 mb-3">GraphQL operations</h2>
          {graphqlGroups.map((g) => <Endpoint key={g.key} g={g} graphqlByName={graphqlByName} />)}
        </section>
      )}

      {restGroups.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold m-0 mb-3">REST / RPC endpoints</h2>
          {restGroups.map((g) => <Endpoint key={g.key} g={g} graphqlByName={graphqlByName} />)}
        </section>
      )}

      <script dangerouslySetInnerHTML={{ __html: `document.addEventListener('click',function(e){var b=e.target.closest('[data-copy-target]');if(!b)return;var pre=document.getElementById(b.dataset.copyTarget);if(!pre)return;navigator.clipboard.writeText(pre.innerText);var orig=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=orig;},1500);});` }} />
    </Layout>
  )
}

function Kpi({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className={cn('text-lg font-semibold', color)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

function Endpoint({ g, graphqlByName }: { g: EndpointGroup; graphqlByName: Map<string, GraphqlOperation> }) {
  const sample = g.calls[0]!
  const gqlOp = g.graphql?.operationName ? graphqlByName.get(g.graphql.operationName) : undefined
  const responseSamples = g.calls.map((c) => c.responseBody).filter((b): b is string => !!b).map((b) => tryParse(b)).filter((j) => j !== null)
  const requestSamples = g.calls.map((c) => c.requestBody).filter((b): b is string => !!b).map((b) => tryParse(b)).filter((j) => j !== null)
  const responseSchema = responseSamples.length > 0 ? inferType(responseSamples, 'Response') : null
  const requestSchema = requestSamples.length > 0 ? inferType(requestSamples, 'Request') : null
  const statusList = [...g.statuses.entries()].sort(([a], [b]) => a - b).map(([s, n]) => `${s}×${n}`).join(' · ')
  const curl = buildCurl(sample)
  const curlId = `curl-${g.key.replace(/[^a-z0-9]/gi, '_')}`
  return (
    <Card className="mb-3">
      <CardContent className="p-3">
        <div className="flex justify-between gap-3 flex-wrap items-baseline mb-2">
          <div className="flex items-baseline gap-2 flex-wrap min-w-0">
            <MethodPill method={g.method} />
            <code className="text-xs break-all">{g.normalizedPath}</code>
            {g.graphql?.operationName && <span className="text-xs text-purple-500 font-mono">{g.graphql.operationType ?? 'query'} {g.graphql.operationName}</span>}
          </div>
          <div className="text-xs text-muted-foreground">
            <span title="host">{g.hostname}</span> · {g.calls.length} call{g.calls.length === 1 ? '' : 's'} · {statusList}
          </div>
        </div>

        {gqlOp && (
          <Section open summary={`GraphQL operation — ${gqlOp.operationType} ${gqlOp.name}${Object.keys(gqlOp.variableTypes).length > 0 ? ` · ${Object.keys(gqlOp.variableTypes).length} variable${Object.keys(gqlOp.variableTypes).length === 1 ? '' : 's'}` : ''}${gqlOp.typenames.length > 0 ? ` · returns ${gqlOp.typenames.join(', ')}` : ''}`}>
            {Object.keys(gqlOp.variableTypes).length > 0 && <pre className="mb-1.5 text-xs"><code>{formatGqlVariables(gqlOp.variableTypes)}</code></pre>}
            <pre className="text-xs max-h-[400px] overflow-auto"><code>{truncateForDisplay(gqlOp.query, 4000)}</code></pre>
          </Section>
        )}

        {requestSchema && (
          <Section summary="Request body type (TypeScript)">
            <pre className="text-xs max-h-[400px] overflow-auto"><code>{requestSchema}</code></pre>
          </Section>
        )}

        {responseSchema && (
          <Section open summary={`Response type (TypeScript) — inferred from ${responseSamples.length} sample${responseSamples.length === 1 ? '' : 's'}`}>
            <pre className="text-xs max-h-[400px] overflow-auto"><code>{responseSchema}</code></pre>
          </Section>
        )}

        {sample.responseBody && (
          <Section summary={`Sample response (${sample.status} · ${sample.responseMimeType || '?'}${sample.responseSize ? ` · ${formatBytes(sample.responseSize)}` : ''})`}>
            <pre className="text-xs max-h-[400px] overflow-auto"><code>{truncateForDisplay(formatJsonish(sample.responseBody), 4000)}</code></pre>
          </Section>
        )}

        <Section summary="Copy as cURL">
          <pre id={curlId} className="text-xs max-h-[400px] overflow-auto"><code>{curl}</code></pre>
          <button type="button" data-copy-target={curlId} className="mt-1.5 px-2 py-1 text-xs border rounded bg-transparent cursor-pointer hover:bg-muted">Copy</button>
        </Section>
      </CardContent>
    </Card>
  )
}

function Section({ summary, open, children }: { summary: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="mt-2 pt-2 border-t">
      <summary className="cursor-pointer text-xs uppercase tracking-wider text-muted-foreground">{summary}</summary>
      <div className="mt-1.5">{children}</div>
    </details>
  )
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
    } catch {}
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
  return [...groups.values()].sort((a, b) => {
    if (!!a.graphql !== !!b.graphql) return a.graphql ? -1 : 1
    return b.calls.length - a.calls.length
  })
}

function normalizePath(p: string): string {
  return '/' + p.split('/').filter(Boolean).map((seg) => {
    if (/^\d+$/.test(seg)) return '{id}'
    if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}'
    if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}'
    return seg
  }).join('/')
}

function buildCurl(call: ApiCall): string {
  const parts: string[] = [`curl -X ${call.method.toUpperCase()} ${q(call.url)}`]
  const headers = call.requestHeaders ?? {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (lower === 'host' || lower === 'content-length' || lower.startsWith(':')) continue
    parts.push(`  -H ${q(`${k}: ${v}`)}`)
  }
  if (call.requestBody) parts.push(`  --data ${q(truncateForDisplay(call.requestBody, 4000))}`)
  return parts.join(' \\\n')
}

function q(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }
function tryParse(s: string): unknown { try { return JSON.parse(s) } catch { return null } }
function formatJsonish(s: string): string {
  const parsed = tryParse(s)
  if (parsed === null) return s
  try { return JSON.stringify(parsed, null, 2) } catch { return s }
}
function truncateForDisplay(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more chars)` }
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
function formatGqlVariables(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, t]) => `$${k}: ${t}`).join('\n')
}
