import { html, raw } from 'hono/html'
import { Layout, type Renderable } from './layout'
import type { ProjectDigest, EndpointEntry } from '../project-aggregate'
import { inferType } from '../schema-infer'

export function ProjectPage({
  email,
  digest,
}: {
  email: string
  digest: ProjectDigest
}): Renderable {
  const restEndpoints = digest.endpoints.filter((e) => !e.graphql)
  const graphqlEndpoints = digest.endpoints.filter((e) => e.graphql)

  return Layout({
    title: `Project · ${digest.host}`,
    email,
    body: html`
      <p><a href="/">← back to sessions</a></p>
      <h2 style="margin-top: 4px;">${digest.host}</h2>
      <p class="muted">Aggregated across every captured session for this host. Type inference, GraphQL widening, and route maps merge samples from all sessions for a fuller picture than any single capture.</p>

      <div class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px;">
        ${kpi('Sessions', digest.sessionCount, 'var(--fg)')}
        ${kpi('Unique routes', digest.routes.length, '#2f6feb')}
        ${kpi('Unique endpoints', restEndpoints.length, '#1f9d55')}
        ${kpi('GraphQL ops', graphqlEndpoints.length, '#7c4ac2')}
        ${kpi('Static assets', digest.staticAssets.length, 'var(--muted)')}
      </div>

      <div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; border-color: var(--accent);">
        <div style="min-width: 0;">
          <strong style="font-size: 13px;">📋 AI service brief</strong>
          <div class="meta" style="font-size: 11px; margin-top: 2px;">
            Gemini reads the captured screenshots, routes, API surface, GraphQL ops, and user actions, then writes a structured analysis: what this service is, the user journeys observed, tech stack hints with evidence, and a reverse-engineering checklist. Cached per project, regenerates on new uploads.
          </div>
        </div>
        <a class="btn" href="/projects/${encodeURIComponent(digest.host)}/narrative">→ Open service brief</a>
      </div>

      ${digest.endpoints.some((e) => !e.graphql)
        ? html`<div class="card" style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 6px;">
              <strong style="font-size: 13px;">↓ API exports</strong>
              <span class="meta" style="font-size: 11px;">For Postman, Stoplight, Insomnia, openapi-typescript, openapi-generator, …</span>
            </div>
            <div class="meta" style="font-size: 11px; margin-bottom: 10px;">
              OpenAPI 3.0 spec inferred from the union of every captured call across this project. Schemas use enums for small string sets, mark optional fields, and include captured request/response examples. Generate a TypeScript SDK with one line: <code>npx openapi-typescript ${escapeAttr(`openapi-${safeHost(digest.host)}.json`)} -o client.ts</code>.
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <a class="btn secondary" href="/projects/${encodeURIComponent(digest.host)}/openapi.json" download>↓ OpenAPI 3.0 (.json)</a>
              <a class="btn secondary" href="/projects/${encodeURIComponent(digest.host)}/postman.json" download>↓ Postman collection (.json)</a>
            </div>
          </div>`
        : ''}

      <div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; border-color: var(--accent);">
        <div style="min-width: 0;">
          <strong style="font-size: 13px;">↓ Runnable local clone</strong>
          <div class="meta" style="font-size: 11px; margin-top: 2px;">
            One zip with the latest captured frontend, an aggregated mock for every API ever called, and <code>run.sh</code> that starts both. Unzip → <code>./run.sh</code> → open <code>http://localhost:8080</code>. The complete reverse-engineering deliverable.
          </div>
        </div>
        <a class="btn" href="/projects/${encodeURIComponent(digest.host)}/clone.zip" download>↓ Download clone.zip</a>
      </div>

      ${digest.graphqlOps.length > 0
        ? html`<div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
            <div style="min-width: 0;">
              <strong style="font-size: 13px;">Aggregated GraphQL operations</strong>
              <div class="meta" style="font-size: 11px; margin-top: 2px;">
                ${digest.graphqlOps.length} unique operation${digest.graphqlOps.length === 1 ? '' : 's'} merged across every session. Variable types widened over the union of every captured <code>variables</code> payload.
              </div>
            </div>
            <a class="btn" href="/projects/${encodeURIComponent(digest.host)}/graphql.txt" download>↓ Download operations.graphql</a>
          </div>`
        : ''}

      ${restEndpoints.length > 0
        ? html`<div class="card" style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
            <div style="min-width: 0;">
              <strong style="font-size: 13px;">Aggregated mock server</strong>
              <div class="meta" style="font-size: 11px; margin-top: 2px;">
                Single-file Node.js script with every endpoint ever captured. 2xx samples from any session win; ${digest.endpoints.reduce((n, e) => n + e.callCount, 0)} total calls fed in.
              </div>
            </div>
            <a class="btn" href="/projects/${encodeURIComponent(digest.host)}/api/mock" download>↓ Download mock server</a>
          </div>`
        : ''}

      <div class="section">
        <h2>Sessions (${digest.sessions.length})</h2>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          ${digest.sessions
            .slice()
            .sort((a, b) => b.uploadedAt - a.uploadedAt)
            .map((s) => html`<a class="badge" style="text-decoration: none;" href="/sessions/${s.id}" title="${s.startedAt}">${s.id.slice(0, 8)} · ${formatAgo(s.uploadedAt)}</a>`)}
        </div>
      </div>

      ${digest.routes.length > 0
        ? html`<div class="section">
            <h2>Route map (${digest.routes.length})</h2>
            <div class="card">
              ${digest.routes.map((r) => html`<div style="display: flex; gap: 8px; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border);">
                <code style="font-size: 12px; word-break: break-all;">${r.url}</code>
                <span class="meta" style="white-space: nowrap; font-size: 11px;">${r.visitCount} visit${r.visitCount === 1 ? '' : 's'} · ${r.sessionCount} session${r.sessionCount === 1 ? '' : 's'}</span>
              </div>`)}
            </div>
          </div>`
        : ''}

      ${graphqlEndpoints.length > 0
        ? html`<div class="section">
            <h2>GraphQL operations</h2>
            ${graphqlEndpoints.map((e) => renderEndpoint(e, digest))}
          </div>`
        : ''}

      ${restEndpoints.length > 0
        ? html`<div class="section">
            <h2>REST / RPC endpoints</h2>
            ${restEndpoints.map((e) => renderEndpoint(e, digest))}
          </div>`
        : ''}

      <style>${raw(PROJECT_CSS)}</style>
    `,
  })
}

function renderEndpoint(e: EndpointEntry, digest: ProjectDigest): Renderable {
  const requestJson = e.requestSamples.map(tryParse).filter((j) => j !== null)
  const responseJson = e.responseSamples.map(tryParse).filter((j) => j !== null)
  const requestSchema = requestJson.length > 0 ? inferType(requestJson, 'Request') : null
  const responseSchema = responseJson.length > 0 ? inferType(responseJson, 'Response') : null

  const matchingGqlOp = e.graphql?.operationName
    ? digest.graphqlOps.find((op) => op.name === e.graphql!.operationName)
    : undefined

  const statusList = Object.entries(e.statuses)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([s, n]) => `${s}×${n}`)
    .join(' · ')

  return html`<div class="endpoint">
    <div class="endpoint-head">
      <div class="endpoint-id">
        <span class="method m-${e.method.toLowerCase()}">${e.method}</span>
        <code>${e.normalizedPath}</code>
        ${e.graphql?.operationName
          ? html`<span class="gql-op">${e.graphql.operationType ?? 'query'} ${e.graphql.operationName}</span>`
          : ''}
      </div>
      <div class="endpoint-meta">
        <span title="host">${e.hostname}</span>
        · ${e.callCount} call${e.callCount === 1 ? '' : 's'}
        · ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}
        · ${statusList}
      </div>
    </div>

    ${matchingGqlOp
      ? html`<details class="endpoint-section" open>
          <summary>GraphQL operation — ${matchingGqlOp.operationType} ${matchingGqlOp.name}${matchingGqlOp.typenames.length > 0 ? ` · returns ${matchingGqlOp.typenames.join(', ')}` : ''}</summary>
          ${Object.keys(matchingGqlOp.variableTypes).length > 0
            ? html`<pre style="margin-bottom: 6px;"><code>${Object.entries(matchingGqlOp.variableTypes).map(([k, t]) => `$${k}: ${t}`).join('\n')}</code></pre>`
            : ''}
          <pre><code>${truncate(matchingGqlOp.query, 4000)}</code></pre>
        </details>`
      : ''}

    ${requestSchema
      ? html`<details class="endpoint-section">
          <summary>Request type — inferred from ${requestJson.length} sample${requestJson.length === 1 ? '' : 's'} across ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}</summary>
          <pre><code>${requestSchema}</code></pre>
        </details>`
      : ''}

    ${responseSchema
      ? html`<details class="endpoint-section" open>
          <summary>Response type — inferred from ${responseJson.length} sample${responseJson.length === 1 ? '' : 's'} across ${e.sessionCount} session${e.sessionCount === 1 ? '' : 's'}</summary>
          <pre><code>${responseSchema}</code></pre>
        </details>`
      : ''}
  </div>`
}

function kpi(label: string, value: number | string, color: string): Renderable {
  return html`<div style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
    <div style="font-size: 18px; font-weight: 600; color: ${color};">${value}</div>
    <div class="meta" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;">${label}</div>
  </div>`
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `\n… (${s.length - n} more chars)`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function safeHost(s: string): string {
  return s.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 60) || 'project'
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const PROJECT_CSS = `
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
`
